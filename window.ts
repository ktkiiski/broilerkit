export function waitForClose(win: Window, pollInterval = 1000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const interval = setInterval(checkWindow, pollInterval);

        function checkWindow() {
            try {
                if (win.closed) {
                    clearTimeout(interval);
                    resolve();
                }
            } catch (err) {
                clearTimeout(interval);
                reject(err);
            }
        }
        checkWindow();
    });
}
