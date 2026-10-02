import { NgModule, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import TabbyCoreModule, { AppService, ConfigService, ConfigProvider } from 'tabby-core';
import { SettingsTabProvider } from 'tabby-settings';
import { Subscription, firstValueFrom } from 'rxjs';
import { SatelliteService } from './satellite.service';
import { SatelliteSettingsComponent, SatelliteSettingsProvider } from './settings';
import { McpConfigProvider } from './services/mcpConfigProvider';
import { McpLoggerService } from './services/mcpLogger.service';
import { DialogService } from './services/dialog.service';
import { TerminalToolCategory } from './tools/terminal';
import { TabManagementToolCategory } from './tools/tabManagement';
import { SFTPToolCategory } from './tools/sftp';

@NgModule({
    imports: [CommonModule, FormsModule, TabbyCoreModule],
    declarations: [SatelliteSettingsComponent],
    providers: [SatelliteService, McpLoggerService, DialogService, TerminalToolCategory, TabManagementToolCategory, SFTPToolCategory,
        { provide: ConfigProvider, useClass: McpConfigProvider, multi: true },
        { provide: SettingsTabProvider, useClass: SatelliteSettingsProvider, multi: true }],
})
export default class SatelliteModule implements OnDestroy {
    private ready: Subscription;
    private stopped = false;
    private onUnload = () => this.ngOnDestroy();
    constructor(app: AppService, config: ConfigService, private satellite: SatelliteService) {
        this.ready = app.ready$.subscribe(() => { void firstValueFrom(config.ready$).then(() => { if (!this.stopped) satellite.start(); }); });
        window.addEventListener('beforeunload', this.onUnload);
    }
    ngOnDestroy() {
        if (this.stopped) return;
        this.stopped = true; this.ready.unsubscribe(); this.satellite.ngOnDestroy();
        window.removeEventListener('beforeunload', this.onUnload);
    }
}
