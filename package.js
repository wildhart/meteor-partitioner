Package.describe({
  name: "wildhart:partitioner",
  summary: "Transparently divide a meteor app into different instances shared between groups of users.",
  version: "3.0.3",
  git: "https://github.com/wildhart/meteor-partitioner"
});

Package.onUse(function (api) {
  api.versionsFrom(["3.0"]);
  // Client & Server deps
  api.use([
    'accounts-base',
    'check',
    'ecmascript',
    'ddp', // Meteor.publish available
    'mongo' // Mongo.Collection available
  ]);

  api.use("wildhart:env-var-set@0.0.1");

  api.addFiles('hooks.js');
  api.addFiles('common.js');
  api.addFiles('grouping.js', 'server');
  api.addFiles('grouping_client.js', 'client');

  api.export(['Partitioner', 'Grouping']);
});
