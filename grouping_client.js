function userFindHook(userId, selector /*, options */) {
	// Do the usual find for no user or single selector
	if (!userId || Helpers.isDirectUserSelector(selector)) return true;

	// No hooking needed for regular users, taken care of on server
	if (!Partitioner._isAdmin(Meteor.userId())) return true;

	// Don't have admin see itself for global finds
	if (selector == null) {
		selector = {admin: {$exists: false}};
	} else {
		selector.admin = {$exists: false};
	}

	return true;
};

Meteor.users._partitionerBefore.find(userFindHook);
Meteor.users._partitionerBefore.findOne(userFindHook);

function insertHook(userId, doc) {
	if (!userId) throw new Meteor.Error(403, ErrMsg.userIdErr);
	const groupId = Partitioner.group();
	if (!groupId) throw new Meteor.Error(403, ErrMsg.groupErr);
	doc._groupId = groupId;
	return true;
};

Partitioner = {
	group() {
		const userId = Meteor.userId();
		return userId && (Meteor.users._partitionerDirect.findOne(userId, {fields: {group: 1}}) || {}).group;
	},

	// Async alias so isomorphic code can call `await Partitioner.groupAsync()`
	// on both client and server. On the client the lookup is minimongo, so the
	// sync implementation is simply wrapped.
	async groupAsync() {
		return this.group();
	},

	// This can be replaced - currently not documented
	// Don't retrieve full user object - fix bug #32
	_isAdmin(_id) {
		return Meteor.users._partitionerDirect.find({_id, admin: true}, {fields: {_id: 1}}).count() > 0;
	},

	async _isAdminAsync(_id) {
		return this._isAdmin(_id);
	},

	// Add in groupId for client so as not to cause unexpected sync changes
	partitionCollection(collection) {
		// No find hooks needed if server side filtering works properly
		return collection._partitionerBefore.insert(insertHook);
	},
};
