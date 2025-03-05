import * as vscode from 'vscode';
import { MAX_TIME_BETWEEN_RECORDS, ONE_HOUR_IN_MS, TimeTracker } from './timeTracking';
import dayjs from 'dayjs';

const DEBOUNCE = 300
const DEFAULT_API_URL = 'https://api.ascend.sh';

export class Ascend {
    private disposable: vscode.Disposable | null = null;
    private debounceTimeoutId: any | null = null
    private lastActivityTime: number = 0
    private dailyCodingTime: number = 0
    private context
    public repoName: string | null = null
    private repoUrl: string | undefined
    public apiKey: string | undefined
    private apiUrl: string | undefined
    private challenge: any
    private statusBarItem: vscode.StatusBarItem;
    private statusBarVisible: boolean = true;
    public timeTracker: TimeTracker;

    private async getRepo() {
        try {
            const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
            if (!gitExtension) return;

            const gitAPI = gitExtension.getAPI(1);
            const repo = gitAPI.repositories[0];
            if (!repo?.state.remotes.length) return;

            const remote = repo.state.remotes[0];
            const remoteUrl = remote.fetchUrl || remote.pushUrl;
            if (!remoteUrl) return;

            this.repoUrl = remoteUrl
                .replace(/^git@github\.com:/, 'https://github.com/')
                .replace(/\.git$/, '');

            const match = remoteUrl.match(/[\/:]([^\/]+?)(\.git)?$/);
            this.repoName = match?.[1] ?? null;

        } catch (error) {
            console.error("Error getting repo name:", error);
        }
    }

    private async validateDay() {
        if (!this.apiKey || !this.challenge) return

        try {
            const response = await fetch(`${this.apiUrl}/vscode/challenge/validate-day`, {
                method: 'POST',
                headers: {
                    'x-api-key': this.apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(this.challenge)
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            await response.json();

            await this.getCurrentChallenge()
        } catch (error) {
            console.error("Error validating day:", error);
        }
    }

    public async getCurrentChallenge() {
        if (!this.apiKey || !this.repoUrl) return

        try {
            const response = await fetch(`${this.apiUrl}/vscode/challenge?repo_url=${encodeURIComponent(this.repoUrl)}`, {
                method: 'GET',
                headers: {
                    'x-api-key': this.apiKey,
                    'Content-Type': 'application/json'
                },
            });

            if (!response.ok) return
            const challenge = await response.json();
            if (!(challenge as any).error) this.challenge = challenge;
            this.updateStatusBar();

        } catch (error) {
            // @ts-ignore
            if (error instanceof Error && error.message.includes('401'))
                vscode.window.showErrorMessage('Invalid API key. Please update your API key.');
            else
                console.error("Error fetching current challenge:", error);
        }
    }

    constructor(context: vscode.ExtensionContext) {
        this.context = context

        this.statusBarVisible = this.context.globalState.get("ascend.statusBar.visible", true);
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        if (this.statusBarVisible) this.statusBarItem.show();

        context.subscriptions.push(this.statusBarItem);

        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
        this.timeTracker = new TimeTracker(context, timezone);

        this.initialize()
    }

    private async initialize() {
        // wait for the github extension to load
        await new Promise(resolve => setTimeout(resolve, 3000));
        this.apiKey = await this.context.secrets.get("ascend.apiKey");
        this.apiUrl = vscode.workspace.getConfiguration('ascend').get('apiUrl') || DEFAULT_API_URL;

        await this.getRepo()
        if (!this.repoName) return

        await this.getCurrentChallenge()
        this.dailyCodingTime = await this.timeTracker.getTodayTime(this.repoName);
        this.updateStatusBar()
        this.setupEventListeners()
    }

    private setupEventListeners(): void {
        let subscriptions: vscode.Disposable[] = []

        vscode.window.onDidChangeTextEditorSelection((e) => e.kind === vscode.TextEditorSelectionChangeKind.Command ? null : this.onEvent(), this, subscriptions)
        vscode.window.onDidChangeActiveTextEditor(this.onEvent, this, subscriptions)
        vscode.workspace.onDidSaveTextDocument(this.onEvent, this, subscriptions)

        this.disposable = vscode.Disposable.from(...subscriptions);
    }

    private onEvent() {
        if (this.debounceTimeoutId) clearTimeout(this.debounceTimeoutId);

        this.debounceTimeoutId = setTimeout(async () => {
            const now = dayjs().utc().valueOf();
            if (!this.lastActivityTime || !this.repoName) return this.lastActivityTime = now;

            this.lastActivityTime = now;

            const timeDiff = now - this.lastActivityTime;
            if (timeDiff >= MAX_TIME_BETWEEN_RECORDS) return

            const start = this.lastActivityTime
            await this.timeTracker.recordSession({ start, end: now }, this.repoName);

            this.dailyCodingTime = await this.timeTracker.getTodayTime(this.repoName);
            this.updateStatusBar();

            if (this.challenge?.challengedata?.duration) {
                const goal = this.challenge.challengedata.duration * ONE_HOUR_IN_MS;
                const start = dayjs.utc(this.challenge.started).add(this.challenge.nb_done, "day")
                const isDayDone = start.isAfter(dayjs())

                if (this.dailyCodingTime >= goal && !isDayDone) {
                    await this.validateDay();
                }
            }
        }, DEBOUNCE);
    }

    private async updateStatusBar() {
        if (!this.statusBarVisible || !this.repoName || !this.apiKey) return;
        if (!this.challenge) return this.statusBarItem.text = "$(rocket) Ascend: No active challenge";

        const nbDone = this.challenge.nb_done;

        let start = dayjs.utc(this.challenge.started).add(nbDone, "day")

        const dayDone = start.isAfter(dayjs())
        if (dayDone) start = start.subtract(1, "day")
        const end = start.add(1, "day")

        const time = await this.timeTracker.getTimeInWindow({ start: start.valueOf(), end: end.valueOf() }, this.repoName)
        const { hours, minutes } = this.timeTracker.separateTime(time)

        const goal = this.challenge.challengedata?.duration;
        const progress = (time / (goal * ONE_HOUR_IN_MS) * 100).toFixed();
        const dueTime = end.tz(this.timeTracker.timezone).format("HH:mm")

        const text = `$(rocket) ${hours}h ${minutes}m${dayDone ? ' | Day done $(check)' : ` (${progress}%) | Due ${dueTime}`} | Day ${dayDone ? nbDone - 1 : nbDone} / ${this.challenge.time}`

        this.statusBarItem.text = text;
    }

    public toggleStatusBar() {
        this.statusBarVisible = !this.statusBarVisible;
        this.context.globalState.update("ascend.statusBar.visible", this.statusBarVisible);

        if (this.statusBarVisible) {
            this.statusBarItem.show();
            this.updateStatusBar();
        } else {
            this.statusBarItem.hide();
        }
    }

    public dispose() {
        this.statusBarItem.dispose();
        this.disposable?.dispose();
    }
}