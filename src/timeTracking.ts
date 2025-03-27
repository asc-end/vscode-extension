import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { ExtensionContext } from 'vscode';

dayjs.extend(utc);
dayjs.extend(timezone);

const STORAGE_KEY_PREFIX = 'ascend.codingTime'
const PENDING_UPLOADS_KEY = 'ascend.pendingUploads';

export const ONE_MINUTE_IN_MS = 60 * 1000
export const ONE_HOUR_IN_MS = 60 * ONE_MINUTE_IN_MS
export const ONE_DAY_IN_MS = 24 * ONE_HOUR_IN_MS

export const MAX_TIME_BETWEEN_RECORDS = 5 * ONE_MINUTE_IN_MS

// Timestamps in miliseconds
export interface TimeWindow { start: number; end: number; }

// Define interfaces for user and backend configuration
export interface UserInfo {
    userId: number;
    userLogin: string;
    token: string;
}

export class TimeTracker {
    public timezone: string;
    private sessionsByDay: Record<string, TimeWindow[]> = {};
    private context: ExtensionContext;
    private pendingUploads: Record<string, TimeWindow[]> = {};
    private isUploading: boolean = false;
    private apiUrl: string | undefined
    private apiKey: string | undefined


    constructor(context: ExtensionContext, timezone: string = 'UTC', apiUrl?: string, apiKey?: string) {
        this.context = context;
        this.timezone = timezone;
        this.apiUrl = apiUrl;
        this.apiKey = apiKey
        
        // Load any pending uploads from storage
        this.pendingUploads = this.context.globalState.get<Record<string, TimeWindow[]>>(
            PENDING_UPLOADS_KEY, 
            {}
        );
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

        // Get the previous state to identify what changed
        const previousSessions = this.context.globalState.get<TimeWindow[]>(`${STORAGE_KEY_PREFIX}.${repoName}.${dayKey}`) || [];

        // Save the updated sessions
        await this.context.globalState.update(storageKey, sessions);
        
        // Only queue for upload if backend is configured
        if (this.apiUrl) {
            // Find new or modified sessions by comparing with previous state
            const modifiedSessions = sessions.filter(currentSession => {
                // Check if this session exists in previous state
                const matchingPrevious = previousSessions.find(prev =>
                    prev.start === currentSession.start && prev.end === currentSession.end
                );

                // If no match found, this is a new or modified session
                return !matchingPrevious;
            });
            
            if (modifiedSessions.length > 0) {
                // Queue only the modified sessions for upload
                if (!this.pendingUploads[repoName]) {
                    this.pendingUploads[repoName] = [];
                }

                // Add only the modified sessions to pending uploads
                this.pendingUploads[repoName].push(...modifiedSessions);

                // Trigger upload process - but don't wait for it to complete
                this.uploadPendingSessions().catch(err => {
                    console.error('Failed to upload sessions, will retry later:', err);
                    // Sessions remain in pendingUploads for future retry
                });
            }
        }
    }


    public async uploadPendingSessions(): Promise<void> {
        if (!this.apiUrl || this.isUploading) return;

        try {
            this.isUploading = true;

            for (const [repoName, sessions] of Object.entries(this.pendingUploads)) {
                if (sessions.length === 0) continue;

                const sessionsToUpload = [...sessions];

                // Clear the queue before sending to prevent duplicates if upload fails
                this.pendingUploads[repoName] = [];
                await this.context.globalState.update( PENDING_UPLOADS_KEY,  this.pendingUploads);

                try {
                    await this.sendSessionsToBackend(repoName, sessionsToUpload);
                } catch (error) {
                    console.error('Failed to upload sessions:', error);
                    // Put sessions back in the queue for retry
                    if (!this.pendingUploads[repoName]) {
                        this.pendingUploads[repoName] = [];
                    }
                    this.pendingUploads[repoName].push(...sessionsToUpload);
                    await this.context.globalState.update( PENDING_UPLOADS_KEY,  this.pendingUploads);
                    
                    // Don't try to upload more sessions if we're having network issues
                    break;
                }
            }
        } finally {
            this.isUploading = false;
        }
    }

    private async sendSessionsToBackend(repoName: string, sessions: TimeWindow[]): Promise<void> {
        // Skip if no sessions to send or no backend config
        if (!sessions || sessions.length === 0 || !this.apiUrl) return;

        // Format data for the backend
        const payload = {
            repo_name: repoName,
            sessions: sessions.map(session => ({
                start: new Date(session.start).toISOString(),
                end: new Date(session.end).toISOString()
            }))
        };

        try {
            // Send to backend with timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
            
            const response = await fetch(`${this.apiUrl}/vscode/coding-sessions`, {
                method: 'POST',
                headers: {
                    'x-api-key': this.apiKey!,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`Failed to upload sessions: ${response.statusText}`);
            }
        } catch (error) {
            // Specifically handle network errors
            if (error instanceof TypeError && error.message.includes('fetch')) {
                console.log('Network error detected, will retry upload later');
            }
            throw error; // Re-throw to be handled by the caller
        }
    }

    public async recordSession(session: TimeWindow, repoName: string): Promise<void> {
        if (session.start >= session.end) return;

        // Get the day boundaries for the start time
        const startDay = dayjs.utc(session.start).startOf('day');
        const endDay = dayjs.utc(session.end).startOf('day');

        // If session spans multiple days, split it
        if (!startDay.isSame(endDay)) {
            const nextMidnight = endDay.valueOf();

            await this.recordSession({ start: session.start, end: nextMidnight - 1 }, repoName);
            await this.recordSession({ start: nextMidnight, end: session.end }, repoName);
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
        console.log("record sessions", sessions)
        await this.saveSessionsForDay(dayKey, repoName);
    }

    public separateTime(ms: number): { hours: number; minutes: number; seconds: number } {
        const totalSeconds = Math.floor(ms / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        return { hours, minutes, seconds };
    }

    //Initialize pending uploads from storage
    public async initializePendingUploads(): Promise<void> {
        // Get all keys from storage that match our prefix
        const allKeys = this.context.globalState.keys()
            .filter(key => key.startsWith(STORAGE_KEY_PREFIX));
        
        // Process each key to find sessions that need uploading
        for (const key of allKeys) {
            // Extract repo name and day from the key
            // Format is: ascend.codingTime.{repoName}.{dayKey}
            const parts = key.split('.');
            if (parts.length < 4) continue;
            
            const repoName = parts[2];
            const dayKey = parts[3];
            
            // Load the sessions for this day
            const sessions = this.context.globalState.get<TimeWindow[]>(key) || [];
            
            if (sessions.length > 0) {
                // Queue all sessions for upload attempt
                if (!this.pendingUploads[repoName]) {
                    this.pendingUploads[repoName] = [];
                }
                this.pendingUploads[repoName].push(...sessions);
            }
        }
        
        // Try to upload any pending sessions
        if (Object.keys(this.pendingUploads).length > 0) {
            this.uploadPendingSessions().catch(err => {
                console.error('Failed to upload pending sessions on initialization:', err);
            });
        }
    }
} 