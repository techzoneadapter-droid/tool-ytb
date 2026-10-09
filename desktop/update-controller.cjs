const { EventEmitter } = require('node:events');
class DesktopUpdates extends EventEmitter {
  constructor({ updater, version, installed, isBusy, prepareInstall, install, retryMs = 5000 }) {
    super();
    Object.assign(this, { updater, installed, isBusy, prepareInstall, install, retryMs });
    this.state = { phase: installed ? 'idle' : 'development', version, percent: 0, message: installed ? 'Bấm Cập nhật để tải và cài bản mới nhất.' : 'Cập nhật tự động dùng trong bản cài Windows.' };
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.on('update-available', info => { this.available = info; this.set({ nextVersion: info.version }); });
    updater.on('update-not-available', () => { this.requested = false; this.set({ phase: 'current', message: 'Bạn đang dùng bản mới nhất.' }); });
    updater.on('download-progress', progress => this.set({ phase: 'downloading', percent: Math.round(progress.percent), message: 'Đang tải bản mới…' }));
    updater.on('update-downloaded', () => { this.downloaded = true; if (this.requested) void this.tryInstall(); });
    updater.on('error', error => this.fail(error));
  }
  set(patch) { Object.assign(this.state, patch); this.emit('state', { ...this.state }); }
  fail(error) {
    this.emit('failure', error);
    clearTimeout(this.timer); this.requested = false;
    this.set({ phase: 'error', message: 'Chưa cập nhật được. Kiểm tra mạng rồi bấm thử lại; dữ liệu hiện tại được giữ nguyên.' });
  }
  async request() {
    if (!this.installed || ['checking', 'downloading', 'waiting', 'installing'].includes(this.state.phase)) return this.state;
    this.requested = true;
    if (this.downloaded) { void this.tryInstall(); return this.state; }
    this.available = undefined;
    this.set({ phase: 'checking', percent: 0, message: 'Đang kiểm tra bản phát hành trên GitHub…' });
    try {
      await this.updater.checkForUpdates();
      if (this.available && this.requested) {
        this.set({ phase: 'downloading', message: 'Đang tải bản mới…' });
        await this.updater.downloadUpdate();
      }
    } catch (error) { this.fail(error); }
    return this.state;
  }
  async tryInstall() {
    if (this.installing || !this.requested || !this.downloaded) return;
    this.installing = true;
    try {
      if (await this.isBusy()) {
        this.set({ phase: 'waiting', percent: 100, message: 'Đã tải bản mới. Chờ tác vụ hoàn thành rồi tự cài.' });
        this.timer = setTimeout(() => void this.tryInstall(), this.retryMs);
        this.timer.unref?.();
        return;
      }
      this.set({ phase: 'installing', percent: 100, message: 'Đang sao lưu dữ liệu và cài bản mới…' });
      await this.prepareInstall();
      await this.install();
    } catch (error) { this.fail(error); }
    finally { this.installing = false; }
  }
  dispose() { clearTimeout(this.timer); }
}
module.exports = { DesktopUpdates };
