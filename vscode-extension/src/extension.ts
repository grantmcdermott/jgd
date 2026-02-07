import * as vscode from 'vscode';
import { SocketServer } from './socket-server';
import { PlotHistory } from './plot-history';
import { PlotWebviewProvider } from './webview-provider';

let server: SocketServer;
let history: PlotHistory;
let webviewProvider: PlotWebviewProvider;
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
    console.log('vscgd: extension activating');

    history = new PlotHistory(
        vscode.workspace.getConfiguration('vscgd').get('historyLimit', 50)
    );

    webviewProvider = new PlotWebviewProvider(context.extensionUri, history);

    server = new SocketServer(history, webviewProvider);
    server.start();

    // Status bar
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'vscgd.showPlotPane';
    statusBarItem.text = '$(graph) vscgd: waiting';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    server.onConnectionChange((count) => {
        statusBarItem.text = count > 0
            ? `$(graph) vscgd: ${count} session${count > 1 ? 's' : ''}`
            : '$(graph) vscgd: waiting';
    });

    // Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('vscgd.showPlotPane', () => {
            webviewProvider.reveal();
        }),
        vscode.commands.registerCommand('vscgd.previousPlot', () => {
            webviewProvider.navigatePrevious();
        }),
        vscode.commands.registerCommand('vscgd.nextPlot', () => {
            webviewProvider.navigateNext();
        }),
        vscode.commands.registerCommand('vscgd.clearHistory', () => {
            history.clear();
            webviewProvider.refresh();
        }),
        vscode.commands.registerCommand('vscgd.exportPng', () => {
            webviewProvider.exportPlot('png');
        }),
        vscode.commands.registerCommand('vscgd.exportSvg', () => {
            webviewProvider.exportPlot('svg');
        }),
        vscode.commands.registerCommand('vscgd.exportPdf', () => {
            webviewProvider.exportPlot('pdf');
        })
    );

    // Set VSCGD_SOCKET env var for all terminals spawned by VS Code
    server.onReady(() => {
        context.environmentVariableCollection.replace('VSCGD_SOCKET', server.getSocketPath());
    });

    // Set context for keybinding conditions
    vscode.commands.executeCommand('setContext', 'vscgd.hasPlots', false);

    history.onDidChange(() => {
        vscode.commands.executeCommand('setContext', 'vscgd.hasPlots', history.count() > 0);
    });
}

export function deactivate() {
    server?.stop();
}
