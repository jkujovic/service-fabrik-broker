'use strict';

const _ = require('lodash');
const Promise = require('bluebird');
const moment = require('moment');
const uuid = require('uuid');
const crypto = require('crypto');
const Readable = require('stream').Readable;
const HttpClient = require('./HttpClient');
const config = require('../config');
const CONST = require('../constants');
const RetryOperation = require('./RetryOperation');
const randomBytes = Promise.promisify(crypto.randomBytes);
const RiemannClient = require('./RiemannClient');
const DomainSocketClient = require('./DomainSocketClient');
const ServiceBrokerClient = require('./ServiceBrokerClient');
exports.HttpClient = HttpClient;
exports.RetryOperation = RetryOperation;
exports.promiseWhile = promiseWhile;
exports.streamToPromise = streamToPromise;
exports.demux = demux;
exports.parseToken = parseToken;
exports.getTimeAgo = getTimeAgo;
exports.retry = RetryOperation.retry;
exports.encodeBase64 = encodeBase64;
exports.decodeBase64 = decodeBase64;
exports.parseVersion = parseVersion;
exports.compareVersions = compareVersions;
exports.randomBytes = randomBytes;
exports.uuidV4 = uuidV4;
exports.RiemannClient = RiemannClient;
exports.DomainSocketClient = DomainSocketClient;
exports.serviceBrokerClient = new ServiceBrokerClient();
exports.maskSensitiveInfo = maskSensitiveInfo;
exports.deploymentNamesRegExp = deploymentNamesRegExp;
exports.deploymentNameRegExp = deploymentNameRegExp;
exports.getRandomInt = getRandomInt;
exports.isFeatureEnabled = isFeatureEnabled;
exports.isServiceFabrikOperation = isServiceFabrikOperation;
exports.isServiceFabrikOperationFinished = isServiceFabrikOperationFinished;

function streamToPromise(stream, options) {
  const encoding = _.get(options, 'encoding', 'utf8');
  const objectMode = _.get(options, 'objectMode', false);
  if (!(stream instanceof Readable)) {
    stream = new Readable().wrap(stream);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('readable', () => {
      let chunk;
      while ((chunk = stream.read())) {
        if (!objectMode) {
          chunk = chunk.toString(encoding);
        }
        chunks.push(chunk);
      }
    });
    stream.on('end', () => {
      resolve(objectMode ? chunks : chunks.join(''));
    });
    stream.on('error', reject);
  });
}

function demux(stream, options) {
  options = _.assign({
    tail: Infinity
  }, options);
  const stdout = [];
  const stderr = [];

  function takeRight(size) {
    if (stdout.length > size) {
      stdout.splice(0, stdout.length - size);
    }
    if (stderr.length > size) {
      stderr.splice(0, stderr.length - size);
    }
  }

  return new Promise((resolve, reject) => {
    let header = null;
    let chunk = null;
    let stdoutLength = 0;
    let stderrLength = 0;

    function read() {
      if (!header) {
        header = stream.read(8);
      }
      if (!header) {
        return false;
      }
      chunk = stream.read(header.readUInt32BE(4));
      if (!chunk) {
        return false;
      }
      return true;
    }

    function onreadable() {
      while (read()) {
        switch (header.readUInt8(0)) {
        case 2:
          stderrLength++;
          stderr.push(chunk);
          break;
        default:
          stdoutLength++;
          stdout.push(chunk);
        }
        takeRight(2 * options.tail);
        header = null;
        chunk = null;
      }
    }

    function truncatedMessage(logType, length, total) {
      const separator = _.repeat('#', 68);
      return _
        .chain([
          `The "${logType}" log is truncated.`,
          `Only the last ${length} lines of ${total} are shown here.`
        ])
        .map(line => `# ${_.pad(line, separator.length - 4)} #`)
        .tap(lines => {
          lines.unshift(separator);
          lines.push(separator, '...\n');
        })
        .join('\n')
        .value();
    }

    function onend() {
      takeRight(options.tail);
      if (stdoutLength > stdout.length) {
        stdout.unshift(truncatedMessage('stdout', stdout.length, stdoutLength));
      }
      if (stderrLength > stderr.length) {
        stderr.unshift(truncatedMessage('stderr', stderr.length, stderrLength));

      }
      resolve(_.map([stdout, stderr], lines => _.join(lines, '')));
    }

    function onerror(err) {
      reject(err);
    }

    stream.on('readable', onreadable);
    stream.once('end', onend);
    stream.once('error', onerror);
  });
}

function parseToken(token) {
  return _
    .chain(token)
    .split('.')
    .slice(0, 2)
    .map(decodeBase64)
    .value();
}

function getTimeAgo(date, suffixless) {
  return moment.duration(new Date(date).getTime() - Date.now()).humanize(!suffixless);
}

function encodeBase64(obj) {
  return new Buffer(JSON.stringify(obj), 'utf8').toString('base64');
}

function decodeBase64(str) {
  return JSON.parse(new Buffer(str, 'base64').toString('utf8'));
}

function uuidV4() {
  return randomBytes(16)
    .then(buffer => uuid.v4({
      random: buffer
    }));
}

function compareVersions(left, right) {
  return _
    .chain(parseVersion(left))
    .zip(parseVersion(right))
    .map(_.spread((l, r) => l > r ? 1 : l < r ? -1 : 0))
    .compact()
    .first()
    .value() || 0;
}

function parseVersion(version) {
  return _
    .chain(version)
    .split('.', 3)
    .tap(values => {
      while (values.length < 3) {
        values.push('0');
      }
    })
    .map(_.unary(parseInt))
    .value();
}

function promiseWhile(condition, action) {
  return new Promise((resolve, reject) => {
    const loop = () => condition() ? Promise.try(action).then(loop).catch(reject) : resolve();
    loop();
  });
}

function maskSensitiveInfo(target) {
  const mask = function (target, level) {
    const SENSITIVE_FIELD_NAMES = ['password', 'psswd', 'pwd', 'passwd', 'uri', 'url'];
    //For now only the above fields are marked sensitive. If any additional keys are to be added, expand this list.
    if (level === undefined || level < 0) {
      throw new Error('Level argument cannot be undefined or negative value');
    }
    if (level > 4) {
      //Do not recurse beyond 5 levels in deep objects.
      return target;
    }
    if (!_.isPlainObject(target) && !_.isArray(target)) {
      return;
    }
    if (_.isPlainObject(target)) {
      _.forEach(target, (value, key) => {
        if (_.isPlainObject(target[key]) || _.isArray(target[key])) {
          mask(target[key], level + 1);
        }
        if (typeof value === 'string' &&
          _.includes(SENSITIVE_FIELD_NAMES, key)) {
          target[key] = '*******';
        }
      });
    } else if (_.isArray(target)) {
      _.forEach(target, (value) => {
        if (_.isPlainObject(value) || _.isArray(value)) {
          mask(value, level + 1);
        }
      });
    }
  };
  mask(target, 0);
}

function isFeatureEnabled(name) {
  var jobTypes = _.get(config, 'scheduler.job_types');
  var jobTypeList = jobTypes !== undefined ? jobTypes.replace(/\s*/g, '').split(',') : [];
  switch (name) {
  case CONST.FEATURE.SCHEDULED_BACKUP:
    return (_.get(config, 'mongodb.url') !== undefined || _.get(config, 'mongodb.provision.plan_id') !== undefined) &&
      jobTypeList.indexOf(CONST.JOB.SCHEDULED_BACKUP) !== -1;
  case CONST.FEATURE.SCHEDULED_OOB_DEPLOYMENT_BACKUP:
    return jobTypeList.indexOf(CONST.JOB.SCHEDULED_OOB_DEPLOYMENT_BACKUP) !== -1;
  default:
    throw new Error(`Unknown feature : ${name}`);
  }
}

// Gereral regex that is used to filter service fabrik deployments
// from all deployments irrespective of subnet
// checks if starts with 'service-fabrik' and ends with guid
function deploymentNamesRegExp() {
  return new RegExp(`^(${CONST.SERVICE_FABRIK_PREFIX}(_[a-z]*)?)-([0-9]{${CONST.NETWORK_SEGMENT_LENGTH}})-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$`);
}

function deploymentNameRegExp(service_subnet) {
  let subnet = service_subnet ? `_${service_subnet}` : '';
  return new RegExp(`^(${CONST.SERVICE_FABRIK_PREFIX}${subnet})-([0-9]{${CONST.NETWORK_SEGMENT_LENGTH}})-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$`);
}


function getRandomInt(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min)) + min;
}

function isServiceFabrikOperation(params) {
  return _.get(params.parameters, 'service-fabrik-operation') !== undefined;
}

function isServiceFabrikOperationFinished(state) {
  return _.includes([CONST.OPERATION.SUCCEEDED, CONST.OPERATION.FAILED, CONST.OPERATION.ABORTED], state);
}