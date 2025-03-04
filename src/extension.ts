import * as vscode from 'vscode';
import { Ascend } from './ascend';
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

// Configure dayjs to use UTC by default
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
			context.secrets.store("ascend.apiKey", userInput)
		}
		ascend.getCurrentChallenge()
	});
	context.subscriptions.push(apiKeyCommand);

	const viewStatsCommand = vscode.commands.registerCommand('ascend.viewStats', async () => {
		// console.log(repo)
		if(!ascend.repoName){
			vscode.window.showErrorMessage("You need to be in a github repo to get coding stats.")
			return
		}
		const today = dayjs().utc().format('YYYY-MM-DD');
		const codingTime = context.globalState.get<number>(`ascend.codingTime.${ascend.repoName}.${today}`);
		const totalSeconds = Math.round((codingTime || 0) / 1000);
		const hours = Math.floor(totalSeconds / 3600);
		const remainingMinutes = Math.floor((totalSeconds % 3600) / 60);
		const remainingSeconds = totalSeconds % 60;

		vscode.window.showInformationMessage(`Today's coding time on ${ascend.repoName}: ${hours}h ${remainingMinutes}m ${remainingSeconds}s`);
	});
	context.subscriptions.push(viewStatsCommand);
}

export function deactivate() {
	ascend.dispose()
}
