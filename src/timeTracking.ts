import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { ExtensionContext } from 'vscode';

dayjs.extend(utc);
dayjs.extend(timezone);

const STORAGE_KEY_PREFIX = 'ascend.codingTime'

export const ONE_MINUTE_IN_MS = 60 * 1000
export const ONE_HOUR_IN_MS = 60 * ONE_MINUTE_IN_MS
export const ONE_DAY_IN_MS = 24 * ONE_HOUR_IN_MS
export const MAX_TIME_BETWEEN_RECORDS = 5 * ONE_MINUTE_IN_MS

// Timestamps in miliseconds
export interface TimeWindow { start: number; end: number; }

export class TimeTracker {
    public timezone: string;
    private sessionsByDay: Record<string, TimeWindow[]> = {};
    private context: ExtensionContext;

    constructor(context: ExtensionContext, timezone: string = 'UTC') {
        this.context = context;
        this.timezone = timezone;
    }

    public async getTimeInWindow(window: TimeWindow, repoName: string): Promise<number> {
        // Get all day keys that might contain sessions in this window
        const dayKeys = this.getDayKeysInWindow(window);

        // Load all relevant days
        for (const dayKey of dayKeys)
            await this.loadSessionsForDay(dayKey, repoName);

        // Calculate total time
        let totalTime = 0;

        for (const dayKey of dayKeys) {
            const sessions = this.sessionsByDay[dayKey] || [];
            for (const session of sessions) {
                // Calculate overlap between session and window
                const overlapStart = Math.max(session.start, window.start);
                const overlapEnd = Math.min(session.end, window.end);

                // Add overlap time if there is any
                if (overlapStart < overlapEnd) {
                    totalTime += (overlapEnd - overlapStart);
                }
            }
        }
        return totalTime;
    }

    public async getTodayTime(repoName: string): Promise<number> {
        const start = dayjs().tz(this.timezone).startOf('day').valueOf();
        const end = dayjs().tz(this.timezone).endOf('day').valueOf();

        return this.getTimeInWindow({ start, end }, repoName);
    }

    private getDayKey(timestamp: number): string {
        const date = dayjs(timestamp).tz(this.timezone);

        return date.format('YYYY-MM-DD');
    }

    private getDayKeysInWindow(window: TimeWindow): string[] {
        const keys = new Set<string>();
        let currentTimestamp = window.start;

        while (currentTimestamp <= window.end) {
            keys.add(this.getDayKey(currentTimestamp));
            currentTimestamp += ONE_DAY_IN_MS;
        }

        return Array.from(keys);
    }

    private async loadSessionsForDay(dayKey: string, repoName: string): Promise<void> {
        // Skip if already loaded and valid
        if (this.sessionsByDay[dayKey]) return;

        const storedData = this.context.globalState.get<TimeWindow[]>(`${STORAGE_KEY_PREFIX}.${repoName}.${dayKey}`);

        this.sessionsByDay[dayKey] = Array.isArray(storedData) ? storedData : [];
    }

    private async saveSessionsForDay(dayKey: string, repoName: string): Promise<void> {
        const storageKey = `${STORAGE_KEY_PREFIX}.${repoName}.${dayKey}`;
        const sessions = this.sessionsByDay[dayKey] || [];

        await this.context.globalState.update(storageKey, sessions);
    }

    public async recordSession(session: TimeWindow, repoName: string): Promise<void> {
        if (session.start >= session.end) return;

        // Get the day boundaries for the start time
        const startDay = dayjs.utc(session.start).startOf('day');
        const endDay = dayjs.utc(session.end).startOf('day');

        // If session spans multiple days, split it
        if (!startDay.isSame(endDay)) {
            const nextMidnight = endDay.valueOf();

            // First day: from start to 23:59:59.999
            await this.recordSession({
                start: session.start,
                end: nextMidnight - 1
            }, repoName);

            // Next day: from 00:00:00.000 to end
            await this.recordSession({
                start: nextMidnight,
                end: session.end
            }, repoName);
            return;
        }

        // Original logic for single-day sessions
        const dayKey = this.getDayKey(session.start);
        await this.loadSessionsForDay(dayKey, repoName);

        if (!this.sessionsByDay[dayKey]) this.sessionsByDay[dayKey] = [];

        const sessions = this.sessionsByDay[dayKey];

        // Try to merge with the last session only
        if (sessions.length > 0) {
            const lastSession = sessions[sessions.length - 1];
            if (session.start <= lastSession.end + MAX_TIME_BETWEEN_RECORDS &&
                session.end >= lastSession.start - MAX_TIME_BETWEEN_RECORDS) {
                // Merge sessions
                sessions[sessions.length - 1] = {
                    start: Math.min(lastSession.start, session.start),
                    end: Math.max(lastSession.end, session.end)
                };
                await this.saveSessionsForDay(dayKey, repoName);
                return;
            }
        }

        // If no merge possible, add as new session
        sessions.push(session);
        await this.saveSessionsForDay(dayKey, repoName);
    }

    public separateTime(ms: number): { hours: number; minutes: number; seconds: number } {
        const totalSeconds = Math.floor(ms / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        return { hours, minutes, seconds };
    }
} 