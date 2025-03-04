import dayjs from 'dayjs';
import * as vscode from 'vscode';
import fetch from 'node-fetch';

// in ms -> 2 mn
const MAX_TIME_BETWEEN_HEARTBEATS = 600_000
const DEBOUNCE = 300

export class Ascend {
    private disposable: vscode.Disposable | null = null;
    private debounceTimeoutId: any | null = null
    private lastActivityTime: number = 0
    private dailyCodingTime: number = 0
    private context
    public repoName: string | null = null
    private repoUrl: string | undefined
    private apiKey: string | undefined
    private apiUrl: string | undefined
    private currentChallenge: any

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
                        this.repoUrl = remoteUrl
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
        console.log("save coding time for", this.repoName)
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

    private updateCodingTime() {
        const now = Date.now();
        if (this.lastActivityTime > 0) {
            const timeDiff = now - this.lastActivityTime;
            if (timeDiff < MAX_TIME_BETWEEN_HEARTBEATS) {
                this.dailyCodingTime += timeDiff;
                this.saveDailyCodingTime();
                if (this.currentChallenge && this.dailyCodingTime >= this.currentChallenge.challengedata.duration) {
                    this.validateDay()
                }
                this.lastActivityTime = now;
            }
        }
        this.lastActivityTime = now;
    }

    constructor(context: vscode.ExtensionContext) {
        console.log("New ascend vs code extension")
        console.log(this.apiUrl)
        this.context = context
        this.initialize()
    }

    async getCurrentChallenge() {
        console.log(this.apiKey, this.repoUrl)
        if (!this.apiKey || !this.repoUrl) return

        try {
            const response = await fetch(`${this.apiUrl}/vscode/challenge?repo_url=${encodeURIComponent(this.repoUrl)}`, {
                method: 'GET',
                headers: {
                    'x-api-key': this.apiKey,
                    'Content-Type': 'application/json'
                },
            });
            
            console.log(response.body)
            if (!response.ok) {
                console.log("response not ok", response.status)
            }

            const challenge = await response.json();
            console.log("challenge", challenge)
            this.currentChallenge = challenge;

        } catch (error) {
            // @ts-ignore
            if (error instanceof Error && error.message.includes('401')) {
                vscode.window.showErrorMessage('Invalid API key. Please update your API key.');
            } else {
                console.error("Error fetching current challenge:", error);
            }

        }
    }

    private async initialize() {
        // wait for the github extension to load
        await new Promise(resolve => setTimeout(resolve, 3000));
        this.apiKey = await this.context.secrets.get("ascend.apiKey")
        this.apiUrl = vscode.workspace.getConfiguration('ascend').get('apiUrl') || 'https://api.ascend.com'

        console.log(this.apiUrl)
        await this.getRepo()
        if (!this.repoName) return

        await this.getCurrentChallenge()
        await this.loadDailyCodingTime()
        this.setupEventListeners()
        console.log("Extension initialized for repo:", this.repoName)
    }

    private setupEventListeners(): void {
        let subscriptions: vscode.Disposable[] = []
        // An Event which fires when the selection in an editor has changed.
        vscode.window.onDidChangeTextEditorSelection(this.onChangeSelection, this, subscriptions)

        // An Event which fires when the active editor has changed. Note that the event also fires when the active editor changes to undefined.
        vscode.window.onDidChangeActiveTextEditor(this.onChangeTab, this, subscriptions)

        // An event that is emitted when a text document is saved to disk.
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
            this.updateCodingTime();
        }, DEBOUNCE)
    }

    public dispose() {
        this.disposable?.dispose();
    }
}