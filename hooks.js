// Server hooks - Meteor 3 (no fibers).
//
// On Meteor 2.x every *Async collection/cursor method was a thin wrapper which
// synchronously called the corresponding sync method, so hooking the sync
// prototype methods covered everything. On Meteor 3 the async methods ARE the
// implementation (the server sync methods throw), so this file hooks:
//
//  - the async mutators/queries on Mongo.Collection.prototype
//    (insertAsync, updateAsync, removeAsync, upsertAsync, findOneAsync), and
//  - the consumption points of each cursor returned by find() (fetch/forEach/
//    map/countAsync/observeChanges/_publishCursor/async iteration), because
//    find() itself must stay synchronous and the group lookup may need an
//    async user fetch. The find hook runs (at most once per cursor) at first
//    consumption, mutating cursor._cursorDescription in place - never anything
//    on the shared connection object, so concurrent publications can't see
//    each other's filters (the defect in upstream PR #4).
//
// The hook registration API (collection._partitionerBefore.find/findOne/
// insert/upsert) keeps the classic slot names so grouping.js registration is
// identical on client and server; the registered hook functions themselves are
// async on the server and are always awaited.

let publishUserId;

if (Meteor.isServer) {
	publishUserId = new Meteor.EnvironmentVariable();
	const _publish = Meteor.publish;
	Meteor.publish = function(name, handler, options) {
		return _publish.call(this, name, function(...args) {
			// This function is called repeatedly in publications
			return publishUserId.withValue(this && this.userId, () => handler.apply(this, args));
		}, options)
	}
}

function getUserId () {
	let userId;

	try {
		// Will throw an error unless within method call.
		// Attempt to recover gracefully by catching:
		userId = Meteor.userId && Meteor.userId();
	} catch (e) {}

	if (userId == null && Meteor.isServer) {
		// Get the userId if we are in a publish function.
		userId = publishUserId.get();
	}

	return userId
}

const proto = Mongo.Collection.prototype;
const directEnv = new Meteor.EnvironmentVariable(false);

// Hook slots keep the classic names so grouping.js registers identically on
// client and server. The server maps its async methods onto these slots.
const hookSlots = ['find', 'findOne', 'insert', 'update', 'remove', 'upsert'];

// Methods exposed on _partitionerDirect. `find` stays synchronous (it returns
// a cursor and application code passes those straight to publications).
const directMethods = ['find', 'findOneAsync', 'insertAsync', 'updateAsync', 'removeAsync', 'upsertAsync'];

// create the collection._partitionerBefore.* methods
// have to create it initially using a getter so we can store self=this and create a new group of functions which have access to self
Object.defineProperty(proto, '_partitionerBefore', {
	get() {
		const self = this;
		const fns = {};
		hookSlots.forEach(method => fns[method] = function(hookFn) {
			self['_groupingBefore_'+method] = hookFn;
		});
		// replace the .direct prototype with the created object, so we don't have to recreate it every time.
		Object.defineProperty(this, '_partitionerBefore', {value: fns});
		return fns;
	}
});

// create the collection._partitionerDirect.* methods
// have to create it initially using a getter so we can store self=this and create a new group of functions which have access to self
Object.defineProperty(proto, '_partitionerDirect', {
	get() {
		const self = this;
		const fns = {};
		directMethods.forEach(method => fns[method] = function(...args) {
			// For the async methods the directEnv value survives the awaits inside
			// (AsyncLocalStorage); for `find` the flag is also captured on the
			// cursor itself (see the find wrapper below) so that fetching the
			// cursor AFTER this withValue scope has exited stays direct.
			return directEnv.withValue(true, () => proto[method].apply(self, args));
		});
		// replace the .direct prototype with the created object, so we don't have to recreate it every time.
		Object.defineProperty(this, '_partitionerDirect', {value: fns});
		return fns;
	}
});

global.hookLogging = false;
// if (Meteor.isServer) global.hookLogging = true;

// --------------------------------------------------------------------------
// find(): stays synchronous. Partitioning is applied lazily, once per cursor,
// at the first consumption point, by mutating cursor._cursorDescription
// (which every consumption path - fetch, count, observe, publish - reads).
// --------------------------------------------------------------------------

// Cursor methods which trigger the lazy find hook. The *Async aliases
// (fetchAsync etc.) delegate to the base-name method on the SAME cursor
// instance, so wrapping the base names covers them. observe/observeAsync/
// observeChangesAsync/_publishCursor all funnel through observeChanges, but
// _publishCursor is wrapped too in case an alternative observe driver skips it.
const cursorMethods = ['fetch', 'forEach', 'map', 'countAsync', 'observeChanges', '_publishCursor'];

const _origFind = proto.find;
proto.find = function(...args) {
	const cursor = _origFind.apply(this, args);

	// Unpartitioned collection, or a direct operation: return the cursor
	// untouched. Both direct flags matter: directEnv (_partitionerDirect) and
	// Partitioner._directOps (directOperation - defined later in grouping.js,
	// hence the runtime typeof check). Deciding at find() time also flags
	// direct cursors that are consumed after the direct scope has exited.
	if (!this._groupingBefore_find
		|| directEnv.get() === true
		|| (typeof Partitioner != 'undefined' && Partitioner._directOps.get() === true)
	) return cursor;

	const collection = this;
	const userId = getUserId();

	// Apply the find hook exactly once per cursor, no matter which (or how
	// many) consumption methods run, and even if they run concurrently.
	let hookApplied = null;
	const applyHook = () => hookApplied ||= (async () => {
		const desc = cursor._cursorDescription;
		// the hook may REPLACE selector/options via this.args (null/string selectors)
		const context = {args: [desc.selector, desc.options]};
		global.hookLogging && console.log('hook', 'b4', collection._name+'.find', JSON.stringify(desc.selector), JSON.stringify(desc.options));
		await collection._groupingBefore_find.call(context, userId, desc.selector, desc.options);
		desc.selector = context.args[0];
		desc.options = context.args[1] || desc.options;
		global.hookLogging && console.log('hook', 'af', collection._name+'.find', JSON.stringify(desc.selector), JSON.stringify(desc.options));
	})();

	cursorMethods.forEach(method => {
		const _orig = cursor[method];
		if (typeof _orig != 'function') return;
		cursor[method] = async function(...args) {
			await applyHook();
			return _orig.apply(this, args);
		};
	});

	// for await (const doc of cursor): the async iterator object must be
	// returned synchronously, so delegate through a promise of the real one.
	const _origAsyncIterator = cursor[Symbol.asyncIterator];
	if (typeof _origAsyncIterator == 'function') {
		cursor[Symbol.asyncIterator] = function() {
			const inner = applyHook().then(() => _origAsyncIterator.call(cursor));
			return {
				next: async (...args) => (await inner).next(...args),
				return: async (...args) => {
					const it = await inner;
					return it.return ? it.return(...args) : {value: undefined, done: true};
				},
			};
		};
	}

	return cursor;
};

// --------------------------------------------------------------------------
// Async mutators/queries: same shape as the classic sync wrapper, awaited.
// --------------------------------------------------------------------------

const asyncMethodSlots = {
	findOneAsync: 'findOne',
	insertAsync: 'insert',
	updateAsync: 'update',
	removeAsync: 'remove',
	upsertAsync: 'upsert',
};

Object.entries(asyncMethodSlots).forEach(([method, slot]) => {
	const _orig = proto[method];
	proto[method] = async function(...args) {
		if (directEnv.get()) return _orig.apply(this, args);
		// give the hooks a private context so that they can modify this.args without putting this.args onto the prototype
		const context = {args};
		const userId = getUserId();
		global.hookLogging && typeof args[0]!='string' && console.log('hook', '\n\n');

		// if the method is update or remove, automatically apply the find hooks to limit the update/remove to the user's group
		if ((slot=='update' || slot=='remove') && this._groupingBefore_find) {
			global.hookLogging && typeof args[0]!='string' && console.log('hook', 'b4i', this._name+"."+method, JSON.stringify(args[0]), JSON.stringify(args[1]));
			// don't send args[1] for update or remove.
			// need to send empty object instead to prevent args[1] being modified
			await this._groupingBefore_find.call(context, userId, args[0], {});
			global.hookLogging && typeof args[0]!='string' && console.log('hook', 'afi', this._name+"."+method, JSON.stringify(args[0]), JSON.stringify(args[1]));
		}

		// run the hook
		if (this['_groupingBefore_'+slot]) {
			global.hookLogging && typeof args[0]!='string' && console.log('hook', 'b4', this._name+"."+method, JSON.stringify(args[0]), JSON.stringify(args[1]));
			await this['_groupingBefore_'+slot].call(context, userId, args[0], args[1], args[2]);
			global.hookLogging && typeof args[0]!='string' && console.log('hook', 'af', this._name+"."+method, JSON.stringify(args[0]), JSON.stringify(args[1]));
		}

		// run the original method
		return _orig.apply(this, args);
	}
});
