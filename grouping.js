const multipleGroupCollections = {};
let allowDirectIdSelectors = false;

// Publish admin and group for users that have it
Meteor.publish(null, function () {
	return this.userId && Meteor.users._partitionerDirect.find(this.userId, {fields: {admin: 1, group: 1}});
});

// Special hook for Meteor.users to scope for each group
async function userFindHook(userId, selector /*, options*/) {
	const isDirectSelector = Helpers.isDirectUserSelector(selector);
	if (
		((allowDirectIdSelectors || Partitioner._searchAllUsers.get()) && isDirectSelector)
		|| Partitioner._directOps.get() === true
	) return true;

	let groupId = Partitioner._currentGroup.get();

	// This hook doesn't run if we're not in a method invocation or publish
	// function, and Partitioner._currentGroup is not set
	if (!userId && !groupId) return true;

	if (!groupId) {
		const user = await Meteor.users._partitionerDirect.findOneAsync(userId, {fields: {group: 1}});

		// user will be undefined inside reactive publish when user is deleted while subscribed
		if (!user) return false;

		groupId = user.group;

		// If user is admin and not in a group, proceed as normal (select all users)
		// do user2 findOne separately so that the findOne above can hit the cache
		if (!groupId && (await Meteor.users._partitionerDirect.findOneAsync(userId, {fields: {admin: 1}})).admin) return true;

		// Normal users need to be in a group
		if (!groupId) throw new Meteor.Error(403, ErrMsg.groupErr);

		// Cache in the current async context (no-op outside one - just a cache miss)
		Partitioner._currentGroup._set(groupId);
	}

	// NB: const matters - with async hooks an undeclared global here would race
	// between concurrent invocations
	const filter = {
		"group": groupId,
	};
	if (!isDirectSelector) {
		filter.admin = {$exists: false}
	}
	if (selector == null) {
		this.args[0] = filter;
	} else if (typeof selector == 'string') {
		filter._id = selector;
		this.args[0] = filter;
	} else {
		Object.assign(selector, filter);
	}

	return true;
}

async function hookGetSetGroup(userId) {
	let groupId = Partitioner._currentGroup.get();

	if (!groupId) {
		if (!userId) throw new Meteor.Error(403, ErrMsg.userIdErr);

		groupId = await Partitioner.getUserGroupAsync(userId);
		if (!groupId) throw new Meteor.Error(403, ErrMsg.groupErr);

		// Cache in the current async context (no-op outside one - just a cache miss)
		Partitioner._currentGroup._set(groupId);
	}
	return groupId;
}

// No allow/deny for find so we make our own checks
async function findHook(userId, selector, options) {
	if (
		// Don't scope for direct operations
		Partitioner._directOps.get() === true
		// Fixed in 3.0.0 - now we even add the groupId to direct selectors
		// https://github.com/mizzao/meteor-partitioner/issues/9
		// https://github.com/mizzao/meteor-partitioner/issues/10
		|| (allowDirectIdSelectors && Helpers.isDirectSelector(selector))

	) return true;

	const groupId = await hookGetSetGroup(userId);

	// force the selector to scope for the _groupId
	if (selector == null) {
		this.args[0] = {
			_groupId: groupId,
		};
	} else if (typeof selector == 'string') {
		this.args[0] = {
			_id: selector,
			_groupId: groupId,
		};
	} else {
		selector._groupId = groupId;
	}

	// Adjust options to not return _groupId. Callers may use either the legacy `fields`
	// option or its Meteor 2.6+ alias `projection` - respect whichever is present, so we
	// never clobber a caller's `projection` with an injected `fields` (issue #1).
	if (options == null) {
		this.args[1] = {fields: {_groupId: 0}};
	} else {
		// add {_groupId: 0} to the existing fields/projection unless it has {foo: 1} somewhere
		const key = options.projection ? 'projection' : 'fields';
		if (options[key] == null) options[key] = {};
		if (!Object.values(options[key]).some(v => v)) options[key]._groupId = 0;
	}

	return true;
};

async function insertHook(multipleGroups, userId, doc) {
	// Don't add group for direct inserts
	if (Partitioner._directOps.get() === true) return true;

	const groupId = await hookGetSetGroup(userId);

	doc._groupId = multipleGroups ? [groupId] : groupId;
	return true;
};

async function userInsertHook(userId, doc) {
	// Don't add group for direct inserts
	if (Partitioner._directOps.get() === true) return true;

	const groupId = await hookGetSetGroup(userId);

	doc.group = groupId;

	return true;
};

async function upsertHook(multipleGroups, userId, selector, doc) {
	// Don't add group for direct inserts
	if (Partitioner._directOps.get() === true) return true;

	const groupId = await hookGetSetGroup(userId);

	doc._groupId = multipleGroups ? [groupId] : groupId;
	return true;
};

async function userUpsertHook(userId, selector, doc) {
	// Don't add group for direct inserts
	if (Partitioner._directOps.get() === true) return true;

	const groupId = await hookGetSetGroup(userId);

	doc.group = groupId;
	return true;
};

// Attach the find/insert hooks to Meteor.users
Meteor.users._partitionerBefore.find(userFindHook);
Meteor.users._partitionerBefore.findOne(userFindHook);
Meteor.users._partitionerBefore.insert(userInsertHook);
Meteor.users._partitionerBefore.upsert(userUpsertHook);

function getPartitionedIndex(index) {
	const defaultIndex = {_groupId: 1};

	if (!index) {
		return defaultIndex;
	}

	return {...defaultIndex, ...index};
}


Partitioner = {
	// Meteor environment variables for scoping group operations
	_currentGroup: new Meteor.EnvironmentVariable(),
	_directOps: new Meteor.EnvironmentVariable(),
	_searchAllUsers: new Meteor.EnvironmentVariable(),

	// ============================================================
	// 4.0.0 (Meteor 3): async-only API. The fiber-based sync methods
	// (setUserGroup, getUserGroup, clearUserGroup, group, bindUserGroup,
	// addToGroup, removeFromGroup, _isAdmin) have been REMOVED - the sync
	// Mongo methods they relied on no longer exist on the Meteor 3 server.
	bindGroup(groupId, func) {
		// NOTE: func may be an async function. On Meteor 3 EnvironmentVariable
		// values are preserved across `await` (AsyncLocalStorage), so the
		// group remains bound for the whole async function.
		return this._currentGroup.withValue(groupId, func);
	},

	directOperation(func) {
		// func may be an async function - see note in bindGroup
		return this._directOps.withValue(true, func);
	},

	// ============================================================

	async setUserGroupAsync(userId, groupId) {
		check(userId, String);
		check(groupId, String);

		const user = await Meteor.users._partitionerDirect.findOneAsync(userId, {fields: {group: 1}});
		if (user?.group) {
			throw new Meteor.Error(403, "User is already in a group");
		}

		return Meteor.users._partitionerDirect.updateAsync(userId, {$set: {group: groupId}});
	},

	async getUserGroupAsync(userId) {
		check(userId, String);
		return ((await Meteor.users._partitionerDirect.findOneAsync(userId, {fields: {group: 1}})) || {}).group;
	},

	async clearUserGroupAsync(userId) {
		check(userId, String);
		return Meteor.users._partitionerDirect.updateAsync(userId, {$unset: {group: 1}});
	},

	async groupAsync() {
		const groupId = this._currentGroup.get();
		if (groupId) return groupId;

		let userId;
		try {
			userId = Meteor.userId();
		} catch (error) {}

		return userId && await this.getUserGroupAsync(userId);
	},

	async bindUserGroupAsync(userId, func) {
		const groupId = await Partitioner.getUserGroupAsync(userId);

		if (!groupId) {
			Meteor._debug(`Dropping operation because ${userId} is not in a group`);
			return;
		}

		return Partitioner.bindGroup(groupId, func);
	},

	async _isAdminAsync(_id) {
		return !!(await Meteor.users._partitionerDirect.findOneAsync({_id, admin: true}, {fields: {_id: 1}}));
	},

	async addToGroupAsync(collection, entityId, groupId) {
		if (!multipleGroupCollections[collection._name]) {
			throw new Meteor.Error(403, ErrMsg.multiGroupErr);
		}

		let currentGroupIds = (await collection._partitionerDirect.findOneAsync(entityId, {fields: {_groupId: 1}}))?._groupId;
		if (!currentGroupIds) {
			currentGroupIds = [groupId];
		} else if (typeof currentGroupIds == 'string') {
			currentGroupIds = [currentGroupIds];
		}

		if (currentGroupIds.indexOf(groupId) == -1) {
			currentGroupIds.push(groupId);
			await collection._partitionerDirect.updateAsync(entityId, {$set: {_groupId: currentGroupIds}});
		}
		return currentGroupIds;
	},

	async removeFromGroupAsync(collection, entityId, groupId) {
		if (!multipleGroupCollections[collection._name]) {
			throw new Meteor.Error(403, ErrMsg.multiGroupErr);
		}

		// NB: parentheses around the await are essential here - this is the bug in PR #4
		let currentGroupIds = (await collection._partitionerDirect.findOneAsync(entityId, {fields: {_groupId: 1}}))?._groupId;
		if (!currentGroupIds) {
			return [];
		}

		if (typeof currentGroupIds == 'string') {
			currentGroupIds = [currentGroupIds];
		}
		const index = currentGroupIds.indexOf(groupId);
		if (index != -1) {
			currentGroupIds.splice(index, 1);
			await collection._partitionerDirect.updateAsync(entityId, {$set: {_groupId: currentGroupIds}});
		}

		return currentGroupIds;
	},

	partitionCollection(collection, options = {}) {
		// Because of the deny below, need to create an allow validator
		// on an insecure collection if there isn't one already
		if (collection._isInsecure()) {
			collection.allow({
				insert: () => true,
				update: () => true,
				remove: () => true,
			});
		}

		// Idiot-proof the collection against admin users.
		// allow-deny on Meteor 3 awaits every validator (asyncSome/asyncEvery),
		// so async deny callbacks under the classic keys work for both client
		// sync stubs and *Async calls.
		collection.deny({
			insert: (userId) => Partitioner._isAdminAsync(userId),
			update: (userId) => Partitioner._isAdminAsync(userId),
			remove: (userId) => Partitioner._isAdminAsync(userId),
		});
		collection._partitionerBefore.find(findHook);
		collection._partitionerBefore.findOne(findHook);
		collection._partitionerBefore.upsert((...args) => upsertHook(options.multipleGroups, ...args));
		// These will hook the _validated methods as well

		collection._partitionerBefore.insert((...args) => insertHook(options.multipleGroups, ...args));
		// No update/remove hook necessary, findHook will be used automatically

		// store a hash of which collections allow multiple groups
		if (options.multipleGroups) {
			multipleGroupCollections[collection._name] = true;
		}

		// Index the collections by groupId on the server for faster lookups across groups.
		return collection.createIndexAsync(getPartitionedIndex(options.index), options.indexOptions);
	},

	get allowDirectIdSelectors() {
		return allowDirectIdSelectors;
	},
	set allowDirectIdSelectors(val) {
		if (typeof val != 'boolean') {
			throw new Error('Partitioner.allowDirectIdSelectors can only be boolean');
		}
		allowDirectIdSelectors = val;
		if (val) {
			console.warn('WARNING: setting Partitioner.allowDirectIdSelectors = true may allow unsafe operations!');
		}
	},
};

// Accounts.createUser, etc, checks for case-insensitive matches of the email address
// however, it uses Meteor.users.find which only operates on the partitioned collection
// so will not find a matching user in a different group.
// Hence make them use Meteor.users._partitionerDirect.find instead.
// Don't wrap createUser with Partitioner.directOperation because want inserted user doc to be
// automatically assigned to the group

['createUser', 'createUserAsync', 'findUserByEmail', 'findUserByUsername', '_attemptLogin'].forEach(fn => {
	const orig = Accounts[fn];
	if (orig) {
		Accounts[fn] = function() {
			return Partitioner._searchAllUsers.withValue(true, () => orig.apply(this, arguments));
		};
	} else if (fn == '_attemptLogin' || Package['accounts-password']) {
		// _attemptLogin comes from accounts-base (always present); the others from
		// accounts-password (only expected when that package is installed). If a Meteor
		// update renames one of these (they are not all public API), login and user
		// lookups would silently become partitioned - make that loud at startup instead.
		console.warn(`Partitioner: Accounts.${fn} not found - login/user lookups may be partitioned`);
	}
});
