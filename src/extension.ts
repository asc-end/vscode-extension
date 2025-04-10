import * as vscode from 'vscode';
import { Ascend } from './ascend';
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
dayjs.extend(utc)

var ascend: Ascend
export function activate(context: vscode.ExtensionContext) {
	try {
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
			try {
				if (!ascend.repo.name) {
					vscode.window.showInformationMessage('No Git repository detected. Please open a Git repository to track time.');
					return;
				}

				const codingTime = await ascend.timeTracker.getTodayTime(ascend.repo.name);
				const {seconds, hours, minutes} = ascend.timeTracker.separateTime(codingTime);

				vscode.window.showInformationMessage(
					`Today's coding time on ${ascend.repo.name}: ${hours}h ${minutes}m ${seconds}s`
				);
			} catch (error) {
				console.error('Error in viewStats command:', error);
				vscode.window.showErrorMessage('Failed to get coding stats: ' + (error instanceof Error ? error.message : String(error)));
			}
		});
		context.subscriptions.push(viewStatsCommand);

		const toggleStatusBarCommand = vscode.commands.registerCommand('ascend.toggleStatusBar', () =>  ascend.toggleStatusBar());
		context.subscriptions.push(toggleStatusBarCommand);

	} catch (error) {
	}
}

export function deactivate() {
	if (ascend) {
		ascend.dispose();
	}
}
