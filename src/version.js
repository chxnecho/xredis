'use strict';

// xredis version. We advertise a compatible redis_version so general-purpose
// clients (redis-cli, RedisInsight, ioredis, ...) behave correctly against us.
module.exports = {
  xredisVersion: '0.1.0',
  redisVersion: '7.4.0',
};