var nconf      = require('nconf'),
    path       = require('path'),
    assert     = require('assert'),
    randToken  = require('rand-token'),
    Debug      = require('debug'),
    express    = require('express'),
    bodyParser = require('body-parser'),
    kue        = require('kue'),
    dsCrypt    = require('dead-simple-crypt'),
    Store      = require('secure-store-redis'),
    activity   = require('activity-streams'),
    tv4        = require('tv4');

var Worker     = require('./worker.js'),
    middleware = require('./middleware.js'),
    init       = require('./bootstrap/init.js'),
    Validate   = require('./validate.js');


var debug     = Debug('sockethub:dispatcher'),
    sessionID = randToken.generate(16),
    secret    = randToken.generate(64),
    jobs      = kue.createQueue({
      prefix: 'sockethub:' + sessionID + ':queue',
      redis: nconf.get('redis')
    });


function Sockethub(options) {
  this.counter   = 0;
  this.platforms = init.platforms;

  // initialize express and socket.io objects
  this.app   = express();
  this.http  = require('http').Server(this.app);
  this.io    = require('socket.io')(this.http, { path: init.path });

  debug('sockethub session id: ' + sessionID);
}


Sockethub.prototype.shutdown = function () {};


Sockethub.prototype.boot = function () {
  var self = this;

  // templating engines
  self.app.set('view engine', 'ejs');

  // use bodyParser
  self.app.use(bodyParser.urlencoded({ extended: true }));
  self.app.use(bodyParser.json());

  // routes
  var routesList = [
    'base',
    'examples'
  ].map(function (routeName) {
    var route;
    route = require( path.join(__dirname, '/../', 'routes', routeName) );
    return route.setup(self.app);
  });

  //
  // handle job results
  //
  jobs.on('job complete', function (id, result) {
    kue.Job.get(id, function (err, job) {
      if (err) {
        debug('failed retreiving job #' + id);
        return;
      }

      if (self.io.sockets.connected[job.data.socket]) {
        result = JSON.parse(dsCrypt.decrypt(result, secret));
        debug(job.data.socket + ': job [' + job.id + '] completed with data ', result);
        self.io.sockets.connected[job.data.socket].emit('message', result);
      } else {
        debug('received completed job for non-existant socket');
      }

      job.remove(function (err) {
        if (err) {
          throw err;
        }
        debug('removed completed job #%d', job.id);
      });
    });
  });

  jobs.on('job failed', function (id, errorMessage) {
    kue.Job.get(id, function (err, job) {
      if (err) {
        debug('failed retreiving job #' + id);
        return;
      }

      debug('job [' + job.id + '] failed for socket ' + job.data.socket);
      if (self.io.sockets.connected[job.data.socket]) {
        job.data.msg = JSON.parse(dsCrypt.decrypt(job.data.msg, secret));
        job.data.msg.error = errorMessage;
        self.io.sockets.connected[job.data.socket].emit('failure', job.data.msg);
      }

      job.remove(function (err) {
        if (err) {
          throw err;
        }
        debug('removed failed job #%d', job.id);
      });
    });
  });

  //
  // incoming handlers
  //
  self.io
      .on('connection', function (socket) {

    sdebug = Debug('sockethub:dispatcher:' + socket.id);
    sdebug('connected');

    validate = Validate({
      onfail: function (err, type, msg) {
        sdebug('validation failed for ' + type + '. ' + err);
        // called with validation fails
        if (typeof msg !== 'object') {
          msg = {};
        }
        msg.error = err;

        // send failure
        socket.emit('failure', msg);
      }
    });

    // store interfaces are session specific, extend secret to include socket ID
    var store = new Store({
      namespace: 'sockethub:' + sessionID + ':store',
      secret: secret + socket.id,
      redis: nconf.get('redis')
    });

    // handlers
    socket.on('disconnect', function () {
      sdebug('disconnected');
    });

    socket.on('credentials', middleware(validate('credentials'), function (creds) {
      sdebug('processing credentials');
      // var stream = activity.Stream(creds);
      // sdebug('stream: ', stream);
      store.save(creds.platform, creds.actor, creds, function (err, reply) {
        sdebug('credentials encrypted and saved to ' + creds.actor);
      });
    }));

    socket.on('message', middleware(validate('message'), function (msg) {
      sdebug('processing message ', msg);

      var job = jobs.create('irc', {
        title: socket.id + '-' + (msg.id) ? msg.id : counter++,
        socket: socket.id,
        msg: dsCrypt.encrypt(JSON.stringify(msg), secret)
      }).save(function (err) {
        if (err) {
          sdebug('error adding job [' + job.id + '] to queue: ', err);
        } else {
          sdebug('job [' + job.id + '] added to queue.');
        }
      });
    }));

    // when new activity objects are created on the client side, an event is
    // fired and we receive a copy on the server side.
    socket.on('activity-object', middleware(validate('activity-object'), function (obj) {
      sdebug('processing activity-object: ', obj);
      activity.Object.create(obj);
    }));

  });

  //
  // load platform workers to process from the kue
  //
  self.platforms.forEachRecord(function (platform) {
    var worker = new Worker({
      id: sessionID,
      secret: secret,
      platform: platform
    });
    worker.boot();
  });

  //
  // start up services
  //
  if (nconf.get('kue:enabled')) {
    // start kue UI
    kue.app.listen(nconf.get('kue:port'), nconf.get('kue:host'), function () {
      debug('service queue interface listening on ' + nconf.get('kue:host') + ':' + nconf.get('kue:port'));
    });
  }

  // start socket.io
  self.http.listen(init.port, init.host, function () {
    debug('sockethub listening on ' + init.host + ':' + init.port);
    debug('active platforms: ', init.platforms.getIdentifiers());
  });
};


module.exports = Sockethub;