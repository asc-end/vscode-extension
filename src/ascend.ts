import dayjs from 'dayjs';
import * as vscode from 'vscode';
import fetch from 'node-fetch';

// 5 minutes
const MAX_TIME_BETWEEN_HEARTBEATS = 5 * 60 * 1000
const DEBOUNCE = 300

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
    private currentChallenge: any
    private statusBarItem: vscode.StatusBarItem;
    private statusBarVisible: boolean = true;

    async getRepo() {
        try {
            const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
            if (gitExtension) {
                const gitAPI = gitExtension.getAPI(1);
                console.log(gitAPI.repositories)
                const repo = gitAPI.repositories[0];
                if (repo) {
                    // Get the remote URL which contains the repo name
                    const remotes = repo.state.remotes;
                    if (remotes.length > 0) {
                        // should try for different remotes
                        const remoteUrl = remotes[0].fetchUrl || remotes[0].pushUrl;
                        console.log(remotes[0])
                        this.repoUrl = remoteUrl
                            ?.replace(/^git@github\.com:/, 'https://github.com/')
                            .replace(/\.git$/, '');
                        if (remoteUrl) {
                            // Extract repo name from remote URL
                            const match = remoteUrl.match(/[\/:]([^\/]+?)(\.git)?$/);
                            if (match) {
                                this.repoName = match[1];
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.error("Error getting repo name:", error);
        }
    }

    private async loadDailyCodingTime() {
        if (!this.repoName) return

        const today = new Date().toISOString().split('T')[0];
        const storageKey = `ascend.codingTime.${this.repoName}.${today}`;
        const storedTime = this.context.globalState.get<number>(storageKey);
        this.dailyCodingTime = storedTime ?? 0;
    }

    private async saveDailyCodingTime() {
        if (!this.repoName) return

        const today = dayjs().utc().format('YYYY-MM-DD');
        const storageKey = `ascend.codingTime.${this.repoName}.${today}`;
        await this.context.globalState.update(storageKey, this.dailyCodingTime);
    }

    private async validateDay() {
        if (!this.apiKey || !this.currentChallenge) return

        try {
            const response = await fetch(`${this.apiUrl}/vscode/challenge/validate-day`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    solana_id: this.currentChallenge.solana_id,
                    author: this.currentChallenge.author
                })
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const result = await response.json();
            console.log("Day validated:", result);

        } catch (error) {
            console.error("Error validating day:", error);
        }
    }

    constructor(context: vscode.ExtensionContext) {
        this.context = context

        this.statusBarVisible = this.context.globalState.get("ascend.statusBar.visible", true);
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        if (this.statusBarVisible) this.statusBarItem.show();
        
        context.subscriptions.push(this.statusBarItem);

        this.initialize()
    }

    async getCurrentChallenge() {
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
            if (!challenge.error) this.currentChallenge = challenge;
            this.updateStatusBar();

        } catch (error) {
            // @ts-ignore
            if (error instanceof Error && error.message.includes('401'))
                vscode.window.showErrorMessage('Invalid API key. Please update your API key.');
            else
                console.error("Error fetching current challenge:", error);
        }
    }

    private async initialize() {
        // wait for the github extension to load
        await new Promise(resolve => setTimeout(resolve, 3000));
        this.apiKey = await this.context.secrets.get("ascend.apiKey")
        this.apiUrl = vscode.workspace.getConfiguration('ascend').get('apiUrl') || 'https://api.ascend.com'

        await this.getRepo()
        if (!this.repoName) return

        await this.getCurrentChallenge()
        await this.loadDailyCodingTime()
        this.updateStatusBar()
        this.setupEventListeners()
    }

    private setupEventListeners(): void {
        let subscriptions: vscode.Disposable[] = []

        vscode.window.onDidChangeTextEditorSelection(this.onChangeSelection, this, subscriptions)
        vscode.window.onDidChangeActiveTextEditor(this.onChangeTab, this, subscriptions)
        vscode.workspace.onDidSaveTextDocument(this.onSave, this, subscriptions)

        this.disposable = vscode.Disposable.from(...subscriptions);
    }

    private onChangeSelection(e: vscode.TextEditorSelectionChangeEvent) {
        if (e.kind === vscode.TextEditorSelectionChangeKind.Command) return;
        this.onEvent()
    }

    private onChangeTab() { this.onEvent() }
    private onSave() { this.onEvent() }

    private onEvent() {
        if (this.debounceTimeoutId) clearTimeout(this.debounceTimeoutId)

        this.debounceTimeoutId = setTimeout(() => {
            const now = Date.now();
            if (this.lastActivityTime > 0) {
                const timeDiff = now - this.lastActivityTime;
                if (timeDiff < MAX_TIME_BETWEEN_HEARTBEATS) {
                    this.dailyCodingTime += timeDiff;
                    this.saveDailyCodingTime();
                    this.updateStatusBar();
                    if (this.currentChallenge && this.dailyCodingTime >= this.currentChallenge.challengedata.duration * 60 * 60 * 1000) {
                        this.validateDay()
                    }
                    this.lastActivityTime = now;
                }
            }
            this.lastActivityTime = now;
        }, DEBOUNCE)
    }

    private updateStatusBar() {
        if (!this.statusBarVisible) return;
        if (!this.apiKey) return this.statusBarItem.text = "$(rocket) Ascend: Click to setup";
        if (!this.currentChallenge) return this.statusBarItem.text = "$(rocket) Ascend: No active challenge";

        const totalSeconds = Math.round(this.dailyCodingTime / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);

        const targetHours = this.currentChallenge.challengedata?.duration;
        const progress = (this.dailyCodingTime / (60 * 60 * 10)) / targetHours;

        this.statusBarItem.text = `$(rocket) Ascend: ${hours}h ${minutes}m / ${targetHours}h (${parseFloat(progress.toFixed(2))}%)`;
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