Package.describe({
  name: "wildhart:partitioner",
  summary: "Transparently divide a meteor app into different instances shared between groups of users.",
  version: "3.2.0",
  git: "https://github.com/wildhart/meteor-partitioner"
});

Package.onUse(function (api) {
  api.versionsFrom(["1.6.1", "2.3"]);
  // Client & Server deps
  api.use([
    'accounts-base',
    'check',
    'ecmascript',
    'ddp', // Meteor.publish available
    'mongo' // Mongo.Collection available
  ]);

  // Still required on Meteor 2.x: provides EnvironmentVariable.prototype.set,
  // which the find/insert hooks use to cache the current groupId.
  // Meteor 2.x async/await is fiber-backed, so this continues to work with
  // fully async application code. Must be replaced when moving to Meteor 3.
  api.use("wildhart:env-var-set@0.0.1");

  api.addFiles('hooks.js');
  api.addFiles('common.js');
  api.addFiles('grouping.js', 'server');
  api.addFiles('grouping_client.js', 'client');

  api.export(['Partitioner', 'Grouping']);
});
