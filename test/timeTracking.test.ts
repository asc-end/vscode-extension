import * as assert from 'assert';
import { ONE_DAY_IN_MS, ONE_HOUR_IN_MS, ONE_MINUTE_IN_MS, TimeTracker, TimeWindow } from '../src/timeTracking';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { ExtensionContext } from 'vscode';

dayjs.extend(utc);
dayjs.extend(timezone);
const repoName = 'test-repo';

dayjs.tz.setDefault("UTC");

suite('TimeTracker Test Suite', () => {
    let timeTracker: TimeTracker;
    let mockContext: Partial<ExtensionContext>;
    let storedSessions: Record<string, TimeWindow[]> = {};

    setup(() => {
        // Mock the ExtensionContext
        mockContext = {
            globalState: {
                get: (key: string) => storedSessions[key],
                update: async (key: string, value: any) => {
                    storedSessions[key] = value;
                    return Promise.resolve();
                },
                setKeysForSync: () => { },
                keys: () => Object.keys(storedSessions)
            }
        };

        timeTracker = new TimeTracker(mockContext as ExtensionContext, 'UTC');
        storedSessions = {}; // Reset stored sessions before each test
    });

    test('separateTime converts milliseconds correctly', () => {
        const testCases = [
            { input: 3661000, expected: { hours: 1, minutes: 1, seconds: 1 } },
            { input: 7200000, expected: { hours: 2, minutes: 0, seconds: 0 } },
            { input: 300000, expected: { hours: 0, minutes: 5, seconds: 0 } },
            { input: 45296000, expected: { hours: 12, minutes: 34, seconds: 56 } },
            { input: 86399000, expected: { hours: 23, minutes: 59, seconds: 59 } },
            { input: 0, expected: { hours: 0, minutes: 0, seconds: 0 } },
        ];

        testCases.forEach(({ input, expected }) => {
            const result = timeTracker.separateTime(input);
            assert.deepStrictEqual(result, expected);
        });
    });

    test('recordSession merges adjacent sessions within record window', async () => {
        const baseTime = dayjs().utc().startOf('day').valueOf() + 5 * ONE_HOUR_IN_MS;
        const dayKey = dayjs(baseTime).format('YYYY-MM-DD');

        // Record first session
        await timeTracker.recordSession({
            start: baseTime,
            end: baseTime + (5 * ONE_MINUTE_IN_MS)
        }, repoName);

        // Verify first session was stored
        let stored = storedSessions[`ascend.codingTime.${repoName}.${dayKey}`];
        assert.strictEqual(stored?.length, 1);
        assert.strictEqual(stored[0].end - stored[0].start, 5 * ONE_MINUTE_IN_MS);

        // Record adjacent session (within record window)
        await timeTracker.recordSession({
            start: baseTime + (8.33 * ONE_MINUTE_IN_MS),
            end: baseTime + (10 * ONE_MINUTE_IN_MS)
        }, repoName);

        // Verify sessions were merged
        stored = storedSessions[`ascend.codingTime.${repoName}.${dayKey}`];
        assert.strictEqual(stored.length, 1);
        assert.strictEqual(stored[0].end - stored[0].start, 10 * ONE_MINUTE_IN_MS);

        const totalTime = await timeTracker.getTodayTime(repoName);
        assert.strictEqual(totalTime, 10 * ONE_MINUTE_IN_MS); // Should be 10 minutes total
    });

    test('recordSession splits sessions across midnight', async () => {
        const midnight = dayjs().utc().startOf('day').valueOf();

        // Record session spanning midnight
        await timeTracker.recordSession({
            start: midnight - ONE_HOUR_IN_MS, // 1 hour before midnight
            end: midnight + ONE_HOUR_IN_MS // 1 hour after midnight
        }, repoName);

        // Check time for both days
        const day1Window = { 
            start: midnight - ONE_DAY_IN_MS, 
            end: midnight - 1 // End just before midnight
        };

        const day2Window = { 
            start: midnight + 1, // Start exactly at midnight
            end: midnight + ONE_DAY_IN_MS - 1
        };

        const allDaysWindow = {
            start: midnight - ONE_DAY_IN_MS, 
            end: midnight + ONE_DAY_IN_MS - 1
        }

        const day1Time = await timeTracker.getTimeInWindow(day1Window, repoName);
        const day2Time = await timeTracker.getTimeInWindow(day2Window, repoName);
        const allDaysTime = await timeTracker.getTimeInWindow(allDaysWindow, repoName);

        assert.strictEqual(day1Time, ONE_HOUR_IN_MS - 1); // 1 hour in first day
        assert.strictEqual(day2Time, ONE_HOUR_IN_MS - 1); // 1 hour in second day
        assert.strictEqual(allDaysTime, 2 * ONE_HOUR_IN_MS -1); // 2 hours total

        const todayTime = await timeTracker.getTodayTime(repoName)
        assert.strictEqual(todayTime, ONE_HOUR_IN_MS)
    });

    test('getTimeInWindow handles overlapping sessions correctly', async () => {
        const baseTime = dayjs().utc().startOf('day').valueOf() + 5 * ONE_HOUR_IN_MS;

        // Create overlapping sessions
        await timeTracker.recordSession({
            start: baseTime,
            end: baseTime + 2 * ONE_HOUR_IN_MS // 2 hours
        }, repoName);

        await timeTracker.recordSession({
            start: baseTime + 1 * ONE_HOUR_IN_MS, // 1 hour offset
            end: baseTime + 3 * ONE_HOUR_IN_MS // 3 hours
        }, repoName);

        // Query a window containing both sessions
        const window = {
            start: baseTime,
            end: baseTime + 24 * ONE_HOUR_IN_MS
        };

        const totalTime = await timeTracker.getTimeInWindow(window, repoName);
        assert.ok(Math.abs(totalTime - 3 * ONE_HOUR_IN_MS) <= 1); // Should be 3 hours total (±1ms)
    });

    test('getTodayTime returns correct time for today only', async () => {
        const now = dayjs().utc();
        const todayStart = now.startOf('day').valueOf() + 2300;
        const yesterdayStart = now.subtract(1, 'day').startOf('day').valueOf();

        // Record a session for yesterday
        await timeTracker.recordSession({
            start: yesterdayStart + 3 * ONE_HOUR_IN_MS,
            end: yesterdayStart + 4.2 * ONE_HOUR_IN_MS
        }, repoName);

        // Record a session for today
        await timeTracker.recordSession({
            start: todayStart + 3 * ONE_HOUR_IN_MS,
            end: todayStart + 5 * ONE_HOUR_IN_MS
        }, repoName);

        const todayTime = await timeTracker.getTodayTime(repoName);
        assert.strictEqual(todayTime, 2 * ONE_HOUR_IN_MS); // Should only count today's 1 hour
    });

    test('handles timezone correctly', async () => {
        const timeTracker = new TimeTracker(mockContext as ExtensionContext, 'America/New_York');

        // Create a session at 23:00 UTC
        const sessionStart = dayjs.utc('2024-01-01 23:00:00').valueOf();
        const sessionEnd = dayjs.utc('2024-01-02 01:00:00').valueOf();

        await timeTracker.recordSession({
            start: sessionStart,
            end: sessionEnd
        }, repoName);

        // Check time in EST (18:00-20:00 EST, same day)
        const window = {
            start: dayjs.tz('2024-01-01 00:00:00', 'America/New_York').valueOf(),
            end: dayjs.tz('2024-01-01 23:59:59', 'America/New_York').valueOf()
        };

        const totalTime = await timeTracker.getTimeInWindow(window, repoName);
        assert.strictEqual(totalTime, 7200000); // Should be 2 hours
    });

    test('rejects invalid time windows', async () => {
        const baseTime = dayjs().utc().startOf('day').valueOf();

        // Test end before start
        await timeTracker.recordSession({
            start: baseTime + ONE_HOUR_IN_MS,
            end: baseTime
        }, repoName);

        const stored = storedSessions[`ascend.codingTime.${repoName}.${dayjs(baseTime).format('YYYY-MM-DD')}`];
        assert.strictEqual(stored, undefined); // Should not store invalid session
    });

    test('handles multiple non-adjacent sessions in same day', async () => {
        const baseTime = dayjs().utc().startOf('day').valueOf();

        // First session: 9:00-10:00
        await timeTracker.recordSession({
            start: baseTime + 9 * ONE_HOUR_IN_MS,
            end: baseTime + 10 * ONE_HOUR_IN_MS
        }, repoName);

        // Second session: 14:00-15:00 (not adjacent)
        await timeTracker.recordSession({
            start: baseTime + 14 * ONE_HOUR_IN_MS,
            end: baseTime + 15 * ONE_HOUR_IN_MS
        }, repoName);

        const dayKey = dayjs(baseTime).format('YYYY-MM-DD');
        const stored = storedSessions[`ascend.codingTime.${repoName}.${dayKey}`];

        assert.strictEqual(stored.length, 2); // Should keep sessions separate
        assert.strictEqual(await timeTracker.getTodayTime(repoName), 2 * ONE_HOUR_IN_MS);
    });

    test('handles DST transitions correctly', async () => {
        const timeTracker = new TimeTracker(mockContext as ExtensionContext, 'America/New_York');

        // Session during DST transition (first Sunday in November)
        const dstTransition = dayjs.tz('2024-11-03 01:30:00', 'America/New_York');

        await timeTracker.recordSession({
            start: dstTransition.subtract(1, 'hour').valueOf(),
            end: dstTransition.add(1, 'hour').valueOf()
        }, repoName);

        const window = {
            start: dstTransition.startOf('day').valueOf(),
            end: dstTransition.endOf('day').valueOf()
        };

        const totalTime = await timeTracker.getTimeInWindow(window, repoName);
        assert.strictEqual(totalTime, 2 * ONE_HOUR_IN_MS); // Should be 2 hours regardless of DST
    });

    test('handles sessions exactly at midnight boundary correctly', async () => {
        const midnight = dayjs().utc().startOf('day').valueOf();

        // Session ending exactly at midnight
        await timeTracker.recordSession({
            start: midnight - ONE_HOUR_IN_MS,
            end: midnight
        }, repoName);

        // Session starting exactly at midnight
        await timeTracker.recordSession({
            start: midnight,
            end: midnight + ONE_HOUR_IN_MS
        }, repoName);

        const day1Time = await timeTracker.getTimeInWindow({
            start: midnight - ONE_DAY_IN_MS,
            end: midnight - 1
        }, repoName);

        const day2Time = await timeTracker.getTimeInWindow({
            start: midnight,
            end: midnight + ONE_DAY_IN_MS - 1
        }, repoName);

        assert.ok(Math.abs(day1Time - ONE_HOUR_IN_MS) <= 1); // Should be 1 hour total (±1ms)
        assert.ok(Math.abs(day2Time - ONE_HOUR_IN_MS) <= 1); // Should be 1 hour total (±1ms)
    });

    test('returns zero for empty time windows', async () => {
        const baseTime = dayjs().utc().startOf('day').valueOf();

        const totalTime = await timeTracker.getTimeInWindow({
            start: baseTime,
            end: baseTime + ONE_DAY_IN_MS
        }, repoName);

        assert.strictEqual(totalTime, 0);
    });

    test('merges multiple sequential sessions correctly', async () => {
        const baseTime = dayjs().utc().startOf('day').valueOf();

        // Record multiple sequential sessions within merge window
        await timeTracker.recordSession({ start: baseTime, end: baseTime + 5 * ONE_MINUTE_IN_MS }, repoName);
        await timeTracker.recordSession({
            start: baseTime + 6 * ONE_MINUTE_IN_MS,
            end: baseTime + 10 * ONE_MINUTE_IN_MS
        }, repoName);
        await timeTracker.recordSession({
            start: baseTime + 12 * ONE_MINUTE_IN_MS,
            end: baseTime + 15 * ONE_MINUTE_IN_MS
        }, repoName);

        const dayKey = dayjs(baseTime).format('YYYY-MM-DD');
        const stored = storedSessions[`ascend.codingTime.${repoName}.${dayKey}`];

        assert.strictEqual(stored.length, 1); // All sessions merged into one
        assert.strictEqual(stored[0].end - stored[0].start, 15 * ONE_MINUTE_IN_MS);
    });

    test('calculates total time correctly for large multi-day windows', async () => {
        const baseTime = dayjs().utc().startOf('day').subtract(3, 'day').valueOf();

        // Record sessions on multiple days
        for (let i = 0; i < 3; i++) {
            await timeTracker.recordSession({
                start: baseTime + i * ONE_DAY_IN_MS + 2 * ONE_HOUR_IN_MS,
                end: baseTime + i * ONE_DAY_IN_MS + 4 * ONE_HOUR_IN_MS
            }, repoName);
        }

        const window = {
            start: baseTime,
            end: baseTime + 3 * ONE_DAY_IN_MS
        };

        const totalTime = await timeTracker.getTimeInWindow(window, repoName);
        assert.strictEqual(totalTime, 6 * ONE_HOUR_IN_MS); // 2 hours per day * 3 days
    });
}); 