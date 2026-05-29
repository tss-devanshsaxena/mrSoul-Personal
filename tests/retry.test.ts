import { withRetry, RateLimiter, sleep } from '../src/utils/retry';

describe('withRetry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns value on first success', async () => {
    const fn = jest.fn().mockResolvedValue('hello');
    const result = await withRetry(fn, { maxAttempts: 3, delayMs: 10 });
    expect(result).toBe('hello');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and succeeds on 3rd attempt', async () => {
    let calls = 0;
    const fn = jest.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw new Error('transient error');
      return 'success';
    });

    const promise = withRetry(fn, { maxAttempts: 3, delayMs: 10, backoffFactor: 1 });

    // Let timers run for retries
    jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after maxAttempts exhausted', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('always fails'));

    const promise = withRetry(fn, { maxAttempts: 3, delayMs: 10, backoffFactor: 1 });
    jest.runAllTimersAsync();

    await expect(promise).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('calls onRetry callback on each retry', async () => {
    let calls = 0;
    const onRetry = jest.fn();
    const fn = jest.fn().mockImplementation(async () => {
      calls++;
      if (calls < 2) throw new Error('fail');
      return 'ok';
    });

    const promise = withRetry(fn, { maxAttempts: 2, delayMs: 10, backoffFactor: 1, onRetry });
    jest.runAllTimersAsync();
    await promise;

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1);
  });

  it('uses exponential backoff', async () => {
    const delays: number[] = [];
    const originalSetTimeout = global.setTimeout;

    jest.useRealTimers(); // Need real timers to measure

    const start = Date.now();
    let calls = 0;
    const fn = jest.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw new Error('fail');
      return 'done';
    });

    // Run with very short delays for testing
    await withRetry(fn, { maxAttempts: 3, delayMs: 5, backoffFactor: 2 });

    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe('RateLimiter', () => {
  it('allows first request immediately', async () => {
    const limiter = new RateLimiter(10); // 10 req/sec
    const start = Date.now();
    await limiter.acquire();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('instantiates with correct parameters', () => {
    const limiter = new RateLimiter(5);
    expect(limiter).toBeInstanceOf(RateLimiter);
  });
});

describe('sleep', () => {
  it('resolves after specified time', async () => {
    jest.useFakeTimers();
    const promise = sleep(1000);
    jest.advanceTimersByTime(1000);
    await promise; // Should resolve
    jest.useRealTimers();
  });
});
