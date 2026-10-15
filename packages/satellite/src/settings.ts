import { Component, Injectable } from '@angular/core';
import { ConfigService } from 'tabby-core';
import { SettingsTabProvider } from 'tabby-settings';
import { SatelliteService } from './satellite.service';

@Component({ selector: 'habby-settings', template: `
<h3>Habby satellite</h3>
<p>Status: {{ satellite.client.status }} · Window: {{ satellite.client.windowId }}</p>
<p>The Hub runs independently. Run <code>habby install</code> to set up its private connection.</p>
<label><input type="checkbox" [(ngModel)]="config.store.hubSatellite.enabled" (ngModelChange)="changed()"> Connect this window to Hub</label>
<div><label>Hub state directory <input class="form-control" [(ngModel)]="config.store.hubSatellite.stateDir" (change)="changed()" placeholder="Use installed location"></label></div>
<h4>Terminal controls</h4>
<div><label><input type="checkbox" [(ngModel)]="config.store.mcp.pairProgrammingMode.enabled" (change)="save()"> Ask before commands and sensitive input</label></div>
<div><label><input type="checkbox" [(ngModel)]="config.store.mcp.pairProgrammingMode.showConfirmationDialog" (change)="save()"> Show approval dialogs</label></div>
<div><label><input type="checkbox" [(ngModel)]="config.store.mcp.pairProgrammingMode.autoFocusTerminal" (change)="save()"> Focus the target terminal</label></div>
<div><label><input type="checkbox" [(ngModel)]="config.store.mcp.backgroundExecution.enabled" (change)="save()"> Execute in background</label></div>
<h4>Environment detection</h4>
<div><label><input type="checkbox" [(ngModel)]="config.store.mcp.environmentDetection.enabled" (ngModelChange)="changed()"> Enable environment detection</label></div>
<div><label>Detection <select [(ngModel)]="config.store.mcp.environmentDetection.mode" (change)="save()"><option value="heuristic">Passive</option><option value="active">Active probes (requires write permission and approval)</option></select></label></div>
<h4>SFTP</h4>
<div><label><input type="checkbox" [(ngModel)]="config.store.mcp.sftp.enabled" (ngModelChange)="changed()"> Enable SFTP</label></div>
<div><label><input type="checkbox" [(ngModel)]="config.store.mcp.pairProgrammingMode.confirmFileOperations" (change)="save()"> Confirm sensitive file operations</label></div>
<div><label>Maximum text read bytes <input type="number" min="1" [(ngModel)]="config.store.mcp.sftp.maxFileSize" (change)="save()"></label></div>
<div><label>Maximum upload bytes <input type="number" min="1" [(ngModel)]="config.store.mcp.sftp.maxUploadSize" (change)="save()"></label></div>
<div><label>Maximum download bytes <input type="number" min="1" [(ngModel)]="config.store.mcp.sftp.maxDownloadSize" (change)="save()"></label></div>
` })
export class SatelliteSettingsComponent {
    constructor(public config: ConfigService, public satellite: SatelliteService) {}
    save() { this.config.save(); }
    changed() { this.save(); this.satellite.client.stop(); this.satellite.start(); }
}
@Injectable()
export class SatelliteSettingsProvider extends SettingsTabProvider {
    id = 'hub-satellite'; icon = 'satellite-dish'; title = 'Habby';
    getComponentType() { return SatelliteSettingsComponent; }
}
