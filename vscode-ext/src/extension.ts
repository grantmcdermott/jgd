import * as vscode from 'vscode';
import { SocketServer } from './socket-server';
import { PlotHistory } from './plot-history';
import { PlotWebviewProvider } from './webview-provider';

let server: SocketServer;
let history: PlotHistory;
let webviewProvider: PlotWebviewProvider;
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
    console.log('jgd: extension activating');

    history = new PlotHistory(
        vscode.workspace.getConfiguration('jgd').get('historyLimit', 50)
    );

    webviewProvider = new PlotWebviewProvider(context.extensionUri, history);

    server = new SocketServer(history, webviewProvider);
    server.start();

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'jgd.showPlotPane';
    statusBarItem.text = '$(graph) jgd: waiting';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    server.onConnectionChange((count) => {
        statusBarItem.text = count > 0
            ? `$(graph) jgd: ${count} session${count > 1 ? 's' : ''}`
            : '$(graph) jgd: waiting';
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('jgd.showPlotPane', () => {
            webviewProvider.reveal();
        }),
        vscode.commands.registerCommand('jgd.previousPlot', () => {
            webviewProvider.navigatePrevious();
        }),
        vscode.commands.registerCommand('jgd.nextPlot', () => {
            webviewProvider.navigateNext();
        }),
        vscode.commands.registerCommand('jgd.clearHistory', () => {
            history.clear();
            webviewProvider.refresh();
        }),
        vscode.commands.registerCommand('jgd.exportPng', () => {
            webviewProvider.exportPlot('png');
        }),
        vscode.commands.registerCommand('jgd.exportSvg', () => {
            webviewProvider.exportPlot('svg');
        })
    );

    server.onReady(() => {
        const vars = server.getEnvVars();
        for (const [key, value] of Object.entries(vars)) {
            context.environmentVariableCollection.replace(key, value);
        }
    });

    vscode.commands.executeCommand('setContext', 'jgd.hasPlots', false);

    history.onDidChange(() => {
        vscode.commands.executeCommand('setContext', 'jgd.hasPlots', history.count() > 0);
    });
}

export function deactivate() {
    server?.stop();
}
