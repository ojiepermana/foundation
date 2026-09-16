// Every timestamp that governs queue ownership comes from Redis TIME, not worker clocks.
const time = `local t = redis.call('TIME'); local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)`;

export const dispatch = `${time}
if redis.call('EXISTS', KEYS[1]) == 1 then
  if redis.call('HGET', KEYS[1], 'name') ~= ARGV[2] or redis.call('HGET', KEYS[1], 'payload') ~= ARGV[3] then
    return redis.error_reply('JOB_ID_CONFLICT')
  end
  return ARGV[1]
end
local delay = tonumber(ARGV[4])
redis.call('HSET', KEYS[1], 'id', ARGV[1], 'name', ARGV[2], 'payload', ARGV[3],
  'attempt', '0', 'maxAttempts', ARGV[5], 'createdAt', now, 'updatedAt', now)
if delay > 0 then
  redis.call('HSET', KEYS[1], 'state', 'delayed', 'runAt', now + delay)
  redis.call('ZADD', KEYS[3], now + delay, ARGV[1])
else
  local entry = redis.call('XADD', KEYS[2], '*', 'id', ARGV[1])
  redis.call('HSET', KEYS[1], 'state', 'ready', 'streamId', entry)
end
return ARGV[1]
`;

export const promote = `${time}
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, 100)
for _, id in ipairs(ids) do
  local job = ARGV[1] .. id
  if redis.call('HGET', job, 'state') == 'delayed' then
    local entry = redis.call('XADD', KEYS[2], '*', 'id', id)
    redis.call('HSET', job, 'state', 'ready', 'streamId', entry, 'updatedAt', now)
    redis.call('HDEL', job, 'runAt')
  end
  redis.call('ZREM', KEYS[1], id)
end
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now - tonumber(ARGV[2]))
return #ids
`;

export const acquire = `${time}
local state = redis.call('HGET', KEYS[1], 'state')
if not state or redis.call('HGET', KEYS[1], 'streamId') ~= ARGV[2] then
  redis.call('XACK', KEYS[2], ARGV[1], ARGV[2]); redis.call('XDEL', KEYS[2], ARGV[2]); return nil
end
local pending = redis.call('XPENDING', KEYS[2], ARGV[1], ARGV[2], ARGV[2], 1)
if #pending == 0 or pending[1][2] ~= ARGV[3] then return nil end
if state == 'running' and tonumber(redis.call('HGET', KEYS[1], 'leaseUntil') or '0') > now then return nil end
if state ~= 'ready' and state ~= 'running' then return nil end
local attempt = tonumber(redis.call('HGET', KEYS[1], 'attempt'))
if attempt >= tonumber(redis.call('HGET', KEYS[1], 'maxAttempts')) then
  redis.call('HSET', KEYS[1], 'state', 'failed', 'error', 'JobLeaseExpiredError', 'finishedAt', now, 'updatedAt', now)
  redis.call('HDEL', KEYS[1], 'owner', 'leaseUntil', 'streamId')
  redis.call('EXPIRE', KEYS[1], ARGV[6])
  redis.call('ZADD', KEYS[3], now, redis.call('HGET', KEYS[1], 'id'))
  redis.call('XACK', KEYS[2], ARGV[1], ARGV[2]); redis.call('XDEL', KEYS[2], ARGV[2]); return nil
end
attempt = attempt + 1
redis.call('HSET', KEYS[1], 'state', 'running', 'attempt', attempt, 'owner', ARGV[4], 'leaseUntil', now + tonumber(ARGV[5]), 'updatedAt', now)
return {redis.call('HGET', KEYS[1], 'name'), redis.call('HGET', KEYS[1], 'payload'), tostring(attempt)}
`;

export const heartbeat = `${time}
if redis.call('HGET', KEYS[1], 'state') ~= 'running' or redis.call('HGET', KEYS[1], 'owner') ~= ARGV[1]
  or tonumber(redis.call('HGET', KEYS[1], 'leaseUntil') or '0') <= now then return 0 end
local entry = redis.call('HGET', KEYS[1], 'streamId')
-- Refresh both the lease and pending entry idle timer, without incrementing delivery count.
local pending = redis.call('XCLAIM', KEYS[2], ARGV[2], ARGV[3], 0, entry, 'IDLE', 0, 'JUSTID')
if #pending == 0 then return 0 end
redis.call('HSET', KEYS[1], 'leaseUntil', now + tonumber(ARGV[4]), 'updatedAt', now)
return 1
`;

export const finish = `${time}
if redis.call('HGET', KEYS[1], 'state') ~= 'running' or redis.call('HGET', KEYS[1], 'owner') ~= ARGV[1]
  or tonumber(redis.call('HGET', KEYS[1], 'leaseUntil') or '0') <= now then return 0 end
local id = redis.call('HGET', KEYS[1], 'id')
local entry = redis.call('HGET', KEYS[1], 'streamId')
redis.call('XACK', KEYS[2], ARGV[2], entry); redis.call('XDEL', KEYS[2], entry)
redis.call('HDEL', KEYS[1], 'owner', 'leaseUntil', 'streamId')
redis.call('HSET', KEYS[1], 'updatedAt', now)
if ARGV[3] == '' then
  redis.call('HSET', KEYS[1], 'state', 'completed', 'finishedAt', now)
  redis.call('HDEL', KEYS[1], 'error')
  redis.call('EXPIRE', KEYS[1], ARGV[5])
elseif tonumber(redis.call('HGET', KEYS[1], 'attempt')) >= tonumber(redis.call('HGET', KEYS[1], 'maxAttempts')) then
  redis.call('HSET', KEYS[1], 'state', 'failed', 'finishedAt', now, 'error', ARGV[3])
  redis.call('ZADD', KEYS[4], now, id)
  redis.call('EXPIRE', KEYS[1], ARGV[6])
else
  local runAt = now + tonumber(ARGV[4])
  redis.call('HSET', KEYS[1], 'state', 'delayed', 'runAt', runAt, 'error', ARGV[3])
  redis.call('ZADD', KEYS[3], runAt, id)
end
return 1
`;

export const retry = `${time}
if redis.call('HGET', KEYS[1], 'state') ~= 'failed' then return 0 end
local id = redis.call('HGET', KEYS[1], 'id')
local entry = redis.call('XADD', KEYS[2], '*', 'id', id)
redis.call('HSET', KEYS[1], 'state', 'ready', 'attempt', 0, 'streamId', entry, 'updatedAt', now)
redis.call('HDEL', KEYS[1], 'error', 'finishedAt')
redis.call('PERSIST', KEYS[1]); redis.call('ZREM', KEYS[3], id)
return 1
`;
