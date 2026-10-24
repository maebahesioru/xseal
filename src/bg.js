const api = globalThis.browser ?? globalThis.chrome;
api.action?.onClicked?.addListener(() => { api.runtime.openOptionsPage(); });
