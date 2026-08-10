// Tenant-isolation test suite for wildhart:partitioner 4.0.0 (Meteor 3).
// Two users in two groups; assert no cross-tenant reads or writes through
// every hooked path. Run with:
//   meteor test-packages ./ --driver-package test-in-console
// (or meteortesting:mocha equivalents; these are tinytest tests).

const coll = new Mongo.Collection('partitioner_test_items');
const mcoll = new Mongo.Collection('partitioner_test_shared');

const U1 = 'partitionerTestUser1'; // group g1
const U2 = 'partitionerTestUser2'; // group g2
const ADMIN = 'partitionerTestAdmin'; // admin, no group
const NOGROUP = 'partitionerTestNoGroup'; // regular user, no group

async function resetData() {
	await Partitioner.directOperation(async () => {
		await coll._partitionerDirect.removeAsync({});
		await mcoll._partitionerDirect.removeAsync({});
		await Meteor.users._partitionerDirect.removeAsync({_id: {$in: [U1, U2, ADMIN, NOGROUP]}});
		await Meteor.users._partitionerDirect.insertAsync({_id: U1, username: 'u1', group: 'g1'});
		await Meteor.users._partitionerDirect.insertAsync({_id: U2, username: 'u2', group: 'g2'});
		await Meteor.users._partitionerDirect.insertAsync({_id: ADMIN, username: 'boss', admin: true});
		await Meteor.users._partitionerDirect.insertAsync({_id: NOGROUP, username: 'lost'});
	});
	// seed two docs per group
	await Partitioner.bindGroup('g1', async () => {
		await coll.insertAsync({name: 'a1'});
		await coll.insertAsync({name: 'a2'});
	});
	await Partitioner.bindGroup('g2', async () => {
		await coll.insertAsync({name: 'b1'});
		await coll.insertAsync({name: 'b2'});
	});
}

async function assertRejects(test, promiseFn, expectedError, where) {
	try {
		await promiseFn();
		test.fail(`expected rejection (${where})`);
	} catch (e) {
		if (expectedError) {
			test.equal(e.error, expectedError, `${where}: ${e.message}`);
		}
	}
}

Tinytest.addAsync('partitioner - setup (partition collections, seed users/docs)', async (test) => {
	await Partitioner.partitionCollection(coll);
	await Partitioner.partitionCollection(mcoll, {multipleGroups: true});
	// the test app has no `insecure` package, so partitionCollection's
	// conditional auto-allow didn't fire; add allow rules so the deny test
	// below exercises the deny layer rather than the empty allow list
	coll.allow({insert: () => true, update: () => true, remove: () => true});
	await resetData();
	test.equal(await Partitioner.getUserGroupAsync(U1), 'g1');
	test.equal(await Partitioner.getUserGroupAsync(U2), 'g2');
});

Tinytest.addAsync('partitioner - insertAsync stamps _groupId inside bindGroup', async (test) => {
	const id = await Partitioner.bindGroup('g1', () => coll.insertAsync({name: 'stamped'}));
	const doc = await coll._partitionerDirect.findOneAsync(id);
	test.equal(doc._groupId, 'g1');
	await Partitioner.directOperation(() => coll._partitionerDirect.removeAsync(id));
});

Tinytest.addAsync('partitioner - fetchAsync/countAsync/findOneAsync are scoped to the bound group', async (test) => {
	await Partitioner.bindGroup('g1', async () => {
		const docs = await coll.find().fetchAsync();
		test.equal(docs.length, 2);
		test.isTrue(docs.every(d => ['a1', 'a2'].includes(d.name)), 'only g1 docs');
		test.isTrue(docs.every(d => d._groupId === undefined), '_groupId stripped from results');

		test.equal(await coll.find().countAsync(), 2);

		const one = await coll.findOneAsync({name: 'b1'});
		test.isUndefined(one, 'findOneAsync cannot see the other group');
	});
});

Tinytest.addAsync('partitioner - for-await iteration is scoped', async (test) => {
	await Partitioner.bindGroup('g2', async () => {
		const names = [];
		for await (const doc of coll.find()) {
			names.push(doc.name);
		}
		test.equal(names.sort(), ['b1', 'b2']);
	});
});

Tinytest.addAsync('partitioner - observeChangesAsync (publication data path) is scoped', async (test) => {
	await Partitioner.bindGroup('g1', async () => {
		const seen = [];
		const handle = await coll.find().observeChangesAsync({
			added(id, fields) { seen.push(fields.name); },
		});
		await handle.stop();
		test.equal(seen.sort(), ['a1', 'a2']);
	});
});

Tinytest.addAsync('partitioner - updateAsync/removeAsync cannot touch the other group', async (test) => {
	await Partitioner.bindGroup('g1', async () => {
		const changed = await coll.updateAsync({}, {$set: {touched: true}}, {multi: true});
		test.equal(changed, 2, 'multi update only affects own group');
		const removed = await coll.removeAsync({name: 'b1'});
		test.equal(removed, 0, 'cannot remove another group\'s doc by name');
	});
	const b1 = await Partitioner.directOperation(() => coll._partitionerDirect.findOneAsync({name: 'b1'}));
	test.isNotUndefined(b1, 'b1 still exists');
	test.isUndefined(b1.touched, 'b1 not touched by g1 update');
});

Tinytest.addAsync('partitioner - direct _id selector cannot cross groups', async (test) => {
	const b1 = await coll._partitionerDirect.findOneAsync({name: 'b1'});
	await Partitioner.bindGroup('g1', async () => {
		test.isUndefined(await coll.findOneAsync(b1._id), 'findOneAsync by _id blocked');
		test.equal(await coll.find(b1._id).countAsync(), 0, 'find by _id blocked');
		test.equal(await coll.updateAsync(b1._id, {$set: {hacked: true}}), 0, 'update by _id blocked');
	});
	const after = await coll._partitionerDirect.findOneAsync(b1._id);
	test.isUndefined(after.hacked);
});

Tinytest.addAsync('partitioner - directOperation bypasses scoping, even fetched outside the scope', async (test) => {
	const inside = await Partitioner.directOperation(() => coll.find().fetchAsync());
	test.equal(inside.length, 4, 'direct fetch sees all groups');

	// cursor created inside the direct scope, consumed after it exited
	const cursor = Partitioner.directOperation(() => coll.find());
	const outside = await cursor.fetchAsync();
	test.equal(outside.length, 4, 'direct cursor stays direct after the scope exits');
});

Tinytest.addAsync('partitioner - publication context resolves the group from this.userId', async (test) => {
	Meteor.publish('partitionerTestPub', function() {
		return coll.find();
	});
	const handler = Meteor.server.publish_handlers['partitionerTestPub'];
	const cursor = await handler.call({userId: U1});
	const docs = await cursor.fetchAsync();
	test.equal(docs.length, 2);
	test.isTrue(docs.every(d => ['a1', 'a2'].includes(d.name)), 'publication only sees the user\'s group');
});

Tinytest.addAsync('partitioner - Meteor.users is scoped and hides admins', async (test) => {
	await Partitioner.bindGroup('g1', async () => {
		const users = await Meteor.users.find().fetchAsync();
		test.equal(users.length, 1);
		test.equal(users[0]._id, U1, 'only own-group users visible');
	});
});

Tinytest.addAsync('partitioner - unscoped access outside any context is rejected, not leaked', async (test) => {
	await assertRejects(test, () => coll.find().fetchAsync(), 403, 'fetch with no user/group context');
	await assertRejects(test, () => coll.insertAsync({name: 'orphan'}), 403, 'insert with no user/group context');
});

Tinytest.addAsync('partitioner - multipleGroups add/remove round-trip', async (test) => {
	const id = await Partitioner.bindGroup('g1', () => mcoll.insertAsync({name: 'shared'}));

	// not visible in g2 yet
	await Partitioner.bindGroup('g2', async () => {
		test.equal(await mcoll.find().countAsync(), 0);
	});

	const added = await Partitioner.addToGroupAsync(mcoll, id, 'g2');
	test.equal(added.sort(), ['g1', 'g2']);
	await Partitioner.bindGroup('g2', async () => {
		test.equal(await mcoll.find().countAsync(), 1, 'visible in g2 after addToGroupAsync');
	});

	// regression for PR #4: removeFromGroupAsync must actually remove and
	// return the remaining groups, not always []
	const remaining = await Partitioner.removeFromGroupAsync(mcoll, id, 'g2');
	test.equal(remaining, ['g1']);
	await Partitioner.bindGroup('g2', async () => {
		test.equal(await mcoll.find().countAsync(), 0, 'no longer visible in g2');
	});

	test.equal(
		await Partitioner.removeFromGroupAsync(mcoll, 'missing-id', 'g1'), [],
		'removing from a missing doc returns []',
	);

	await assertRejects(test, () => Partitioner.addToGroupAsync(coll, id, 'g2'), 403, 'multi-group op on single-group collection');
});

Tinytest.addAsync('partitioner - deny idiot-proofing blocks admin client writes', async (test) => {
	await assertRejects(test, () => coll._validatedInsertAsync(ADMIN, {name: 'sneaky'}), 403, 'admin validated insert denied');
	// a grouped user's validated write passes the allow/deny layer
	await Partitioner.bindGroup('g1', async () => {
		await coll._validatedInsertAsync(U1, {name: 'allowed', _id: 'partitionerTestAllowed'});
	});
	await Partitioner.directOperation(() => coll._partitionerDirect.removeAsync({_id: 'partitionerTestAllowed'}));
});

Tinytest.addAsync('partitioner - bindUserGroupAsync binds from userId and drops groupless users', async (test) => {
	const count = await Partitioner.bindUserGroupAsync(U2, () => coll.find().countAsync());
	test.equal(count, 2, 'bound to u2\'s group');

	const dropped = await Partitioner.bindUserGroupAsync(NOGROUP, () => coll.find().countAsync());
	test.isUndefined(dropped, 'operation dropped for groupless user');
});

// Headless self-runner so the suite can run without a browser client:
//   PARTITIONER_SELFTEST=1 meteor test-packages ./ --driver-package test-in-console --once
if (process.env.PARTITIONER_SELFTEST) {
	Meteor.startup(() => {
		const tests = new Map(); // test name -> {ok, failed}
		Tinytest._runTests(
			(results) => {
				let t = tests.get(results.test);
				if (!t) {
					tests.set(results.test, t = {ok: 0, failed: false});
				}
				(results.events || []).forEach(event => {
					if (event.type === 'exception' || event.type === 'fail') {
						t.failed = true;
						console.log(`SELFTEST FAIL: ${results.test}:`, JSON.stringify(event.details || event, null, 2), event.details?.stack || '');
					} else if (event.type === 'ok') {
						t.ok++;
					}
				});
			},
			() => {
				let failures = 0;
				for (const [name, t] of tests) {
					if (t.failed) {
						failures++;
					}
					console.log(`SELFTEST ${t.failed ? 'FAIL' : 'PASS'}: ${name} (${t.ok} assertions)`);
				}
				console.log(`SELFTEST COMPLETE: ${failures} failed, ${tests.size - failures} passed (${tests.size} tests)`);
				process.exit(failures ? 1 : 0);
			},
			// no pathPrefix: tinytest prepends 'tinytest' to every groupPath, and
			// the only tests registered in the test app are this package's anyway
		);
	});
}
