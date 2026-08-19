// Client hooks - Meteor 3 keeps client minimongo fully synchronous, so this is
// the classic sync hook layer. The *Async collection methods on the client are
// thin wrappers which synchronously call the corresponding sync method on the
// prototype, so hooking the sync methods covers async application code too.

function getUserId () {
	let userId;

	try {
		// Will throw an error unless within method call.
		// Attempt to recover gracefully by catching:
		userId = Meteor.userId && Meteor.userId();
	} catch (e) {}

	return userId
}

const proto = Mongo.Collection.prototype;
const directEnv = new Meteor.EnvironmentVariable(false);

const methods = ['find', 'findOne', 'insert', 'update', 'remove', 'upsert'];

// Async names exposed on _partitionerDirect so that isomorphic application
// code can perform direct (unpartitioned) operations with await. These are
// safe on the client because the async wrapper calls the sync method
// synchronously, i.e. still inside directEnv.withValue() below.
const asyncMethods = ['findOneAsync', 'insertAsync', 'updateAsync', 'removeAsync', 'upsertAsync'];
const directMethods = [...methods, ...asyncMethods];

// create the collection._partitionerBefore.* methods
// have to create it initially using a getter so we can store self=this and create a new group of functions which have access to self
Object.defineProperty(proto, '_partitionerBefore', {
	get() {
		// console.log('creating before functions', this._name);
		const self = this;
		const fns = {};
		methods.forEach(method => fns[method] = function(hookFn) {
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
		// console.log('creating direct functions', this._name);
		const self = this;
		const fns = {};
		directMethods.forEach(method => fns[method] = function(...args) {
			return directEnv.withValue(true, () => proto[method].apply(self, args));
		});
		// replace the .direct prototype with the created object, so we don't have to recreate it every time.
		Object.defineProperty(this, '_partitionerDirect', {value: fns});
		return fns;
	}
});

global.hookLogging = false;

methods.forEach(method => {
	const _orig = proto[method];
	proto[method] = function(...args) {
		if (directEnv.get()) return _orig.apply(this, args);
		// give the hooks a private context so that they can modify this.args without putting this.args onto the prototype
		const context = {args};
		const userId = getUserId();
		global.hookLogging && typeof args[0]!='string' && console.log('hook', '\n\n');

		// if the method is update or remove, automatically apply the find hooks to limit the update/remove to the user's group
		if ((method=='update' || method=='remove') && this._groupingBefore_find) {
			global.hookLogging && typeof args[0]!='string' && console.log('hook', 'b4i', this._name+"."+method, JSON.stringify(args[0]), JSON.stringify(args[1]));
			// don't send args[1] for update or remove.
			// need to send empty object instead to prevent args[1] being modified
			this._groupingBefore_find.call(context, userId, args[0], {});
			global.hookLogging && typeof args[0]!='string' && console.log('hook', 'afi', this._name+"."+method, JSON.stringify(args[0]), JSON.stringify(args[1]));
		}

		// run the hook
		if (this['_groupingBefore_'+method]) {
			global.hookLogging && typeof args[0]!='string' && console.log('hook', 'b4', this._name+"."+method, JSON.stringify(args[0]), JSON.stringify(args[1]));
			this['_groupingBefore_'+method].call(context, userId, args[0], args[1], args[2]);
			global.hookLogging && typeof args[0]!='string' && console.log('hook', 'af', this._name+"."+method, JSON.stringify(args[0]), JSON.stringify(args[1]));
		}

		// run the original method
		return _orig.apply(this, args);
	}
});
