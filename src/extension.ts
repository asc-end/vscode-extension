import * as vscode from 'vscode';
import { Ascend } from './ascend';
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
dayjs.extend(utc)

var ascend: Ascend
export function activate(context: vscode.ExtensionContext) {
	ascend = new Ascend(context)

	const apiKeyCommand = vscode.commands.registerCommand('ascend.apiKey', async () => {
		const currentKey = await context.secrets.get("ascend.apiKey")

		const userInput = await vscode.window.showInputBox({
			prompt: 'Enter Ascend API key',
			placeHolder: currentKey ?? 'Type something here...'
		});

		if (userInput) {
			await context.secrets.store("ascend.apiKey", userInput)
			ascend.apiKey = await context.secrets.get("ascend.apiKey")

			// refetch challenge, now we have an apiKey
			ascend.getCurrentChallenge()
		}
	});
	context.subscriptions.push(apiKeyCommand);

	const viewStatsCommand = vscode.commands.registerCommand('ascend.viewStats', async () => {
		if (!ascend.repoName) return

		const codingTime = await ascend.timeTracker.getTodayTime(ascend.repoName);
		const {seconds, hours, minutes} = ascend.timeTracker.separateTime(codingTime)

		vscode.window.showInformationMessage(`Today's coding time on ${ascend.repoName}: ${hours}h ${minutes}m ${seconds}s`);
	});
	context.subscriptions.push(viewStatsCommand);

	const toggleStatusBarCommand = vscode.commands.registerCommand('ascend.toggleStatusBar', () =>  ascend.toggleStatusBar());
	context.subscriptions.push(toggleStatusBarCommand);
}

export function deactivate() {
	ascend.dispose()
}
