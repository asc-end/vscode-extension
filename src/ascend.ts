import * as vscode from 'vscode';
import { MAX_TIME_BETWEEN_RECORDS, ONE_HOUR_IN_MS, TimeTracker } from './timeTracking';
import dayjs from 'dayjs';

const DEBOUNCE = 300
const DEFAULT_API_URL = 'https://api.ascend.sh';

export class Ascend {
    private disposable: vscode.Disposable | null = null;
    private debounceTimeoutId: any | null = null
    private lastActivityTime: number = 0
    private context
    public repoName: string | null = null
    private repoUrl: string | undefined
    public apiKey: string | undefined
    private apiUrl: string | undefined
    private challenge: any
    private statusBarItem: vscode.StatusBarItem;
    private statusBarVisible: boolean = true;
    public timeTracker: TimeTracker;
    private dailyTime: number = 0
    private challengeTime: number = 0

    constructor(context: vscode.ExtensionContext) {
        try {
            this.context = context;

            // Initialize status bar
            this.statusBarVisible = this.context.globalState.get("ascend.statusBar.visible", true);
            this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

            // Show initializing state
            this.statusBarItem.text = "$(rocket) Ascend: Initializing...";

            if (this.statusBarVisible) {
                this.statusBarItem.show();
            }
            context.subscriptions.push(this.statusBarItem);

            // Initialize time tracker
            const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            this.timeTracker = new TimeTracker(context, timezone);

            // Initialize async components
            this.initialize().catch(error => {
                console.error('Error in Ascend initialization:', error);
                throw error;
            });
        } catch (error) {
            console.error('Error in Ascend constructor:', error);
            throw error;
        }
    }

    private async initialize() {
        // wait for the github extension to load
        await new Promise(resolve => setTimeout(resolve, 3000));
        this.apiKey = await this.context.secrets.get("ascend.apiKey");
        this.apiUrl = vscode.workspace.getConfiguration('ascend').get('apiUrl') || DEFAULT_API_URL;

        await this.getRepo()
        if (!this.repoName) {
            this.statusBarItem.text = "$(rocket) Ascend: No Git repository detected.";
            return
        }

        await this.getCurrentChallenge()
        this.dailyTime = await this.timeTracker.getTodayTime(this.repoName);
        await this.updateStatusBar()
        this.setupEventListeners()
    }

    private async getRepo() {
        try {
            const gitExtension = vscode.extensions.getExtension('vscode.git');

            if (!gitExtension) return;

            await gitExtension.activate();

            const gitAPI = gitExtension.exports.getAPI(1);
            if (!gitAPI) return

            const repositories = gitAPI.repositories;
            if (!repositories?.length) return;

            const repo = repositories[0];
            if (!repo?.state?.remotes?.length) return;

            const remote = repo.state.remotes[0];
            const remoteUrl = remote.fetchUrl || remote.pushUrl;
            if (!remoteUrl) return;

            this.repoUrl = remoteUrl
                .replace(/^git@github\.com:/, 'https://github.com/')
                .replace(/\.git$/, '');

            const match = remoteUrl.match(/[\/:]([^\/]+?)(\.git)?$/);
            this.repoName = match?.[1] ?? null;
        } catch (error) {
            throw error; // Re-throw to handle in activate()
        }
    }

    private async validateDay() {
        if (!this.apiKey || !this.challenge) return;
        const extension = this.context.extension
        try {
            const response = await fetch(`${this.apiUrl}/vscode/challenge/validate-day`, {
                method: 'POST',
                headers: {
                    'x-api-key': this.apiKey,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    solana_id: this.challenge.solana_id,
                    author: this.challenge.author,
                    extension,
                    state: this.context.globalState
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            await response.json();

            await this.getCurrentChallenge();
        } catch (error) {
            console.error("Error validating day:", error);
            if (error instanceof Error) {
                if (error.message.includes('401')) {
                    vscode.window.showErrorMessage('Invalid validation attempt. Please try again.');
                } else {
                    vscode.window.showErrorMessage('Failed to validate day. Please try again later.');
                }
            }
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
            try {
                const now = dayjs().utc().valueOf();

                if (!this.lastActivityTime || !this.repoName) {
                    this.lastActivityTime = now;
                    return;
                }

                if (now - this.lastActivityTime >= MAX_TIME_BETWEEN_RECORDS) {
                    this.lastActivityTime = now;
                    return;
                }

                await this.timeTracker.recordSession({ start: this.lastActivityTime, end: now }, this.repoName);

                this.lastActivityTime = now;
                this.dailyTime = await this.timeTracker.getTodayTime(this.repoName);
                this.updateStatusBar();

            } catch (error) {
                console.error('Error in onEvent:', error);
            }
        }, DEBOUNCE);
    }

    private async updateStatusBar() {
        if (!this.statusBarVisible) return;

        if (!this.challenge)
            this.updateStatusBarWithoutChallenge();
        else
            this.updateStatusBarWithChallenge();
    }

    private async updateStatusBarWithoutChallenge() {
        const { hours, minutes } = this.timeTracker.separateTime(this.dailyTime);

        this.statusBarItem.text = `$(rocket) Today: ${hours}h ${minutes}m | No active challenge`;
        this.statusBarItem.tooltip = "Ascend: Click to create a challenge at app.ascend.sh";
        this.statusBarItem.command = {
            title: 'Open Ascend',
            command: 'vscode.open',
            arguments: [vscode.Uri.parse('https://app.ascend.sh')]
        };
    }

    private async updateStatusBarWithChallenge() {
        if (!this.repoName) return
        const { hours, minutes } = this.timeTracker.separateTime(this.dailyTime);

        const nbDone = this.challenge.nb_done;
        let start = dayjs.utc(this.challenge.started).add(nbDone, "day");
        const dayDone = start.isAfter(dayjs());

        if (dayDone)
            start = start.subtract(1, "day")

        const end = start.add(1, "day");

        this.challengeTime = await this.timeTracker.getTimeInWindow({
            start: start.valueOf(),
            end: end.valueOf()
        }, this.repoName);

        const challengeTimeStats = this.timeTracker.separateTime(this.challengeTime);

        const goal = this.challenge.challengedata?.duration;
        const progress = (this.challengeTime / (goal * ONE_HOUR_IN_MS) * 100).toFixed();
        const dueTime = end.tz(this.timeTracker.timezone).format("HH:mm");

        if (this.challengeTime > this.challenge.challengedata.duration * ONE_HOUR_IN_MS && !dayDone)
            this.validateDay()

        const text = `$(rocket) ${challengeTimeStats.hours}h ${challengeTimeStats.minutes}m${dayDone ?
            ' | Day done $(check)' :
            ` (${progress}%) | Due ${dueTime}`
            } | Day ${dayDone ? nbDone - 1 : nbDone} / ${this.challenge.time}`;

        this.statusBarItem.text = text;
        this.statusBarItem.tooltip = `Ascend: Challenge time: ${challengeTimeStats.hours}h ${challengeTimeStats.minutes}m | Today's total time: ${hours}h ${minutes}m`;
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