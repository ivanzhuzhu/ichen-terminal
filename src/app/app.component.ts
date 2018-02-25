﻿import { Component, ChangeDetectionStrategy, Input, Output, enableProdMode } from "@angular/core";
import { Http } from "@angular/http";
import { Observable } from "rxjs/Observable";
import { Subject } from "rxjs/Subject";
import "rxjs/add/operator/map";
import "rxjs/add/operator/do";
import { DataStoreService } from "./services/data-store-service";
import { NetworkService, NetworkState } from "./services/network-service";
import
{
	MessageService,
	IResponseMessage,
	IAliveMessage,
	IJoinMessage,
	IJoinResponseMessage,
	IRequestControllersListMessage,
	IControllersListMessage,
	ICycleDataMessage,
	IControllerStatusMessage,
	IControllerActionMessage
} from "./services/message-service";
import { mixinDictionaryToMap } from "./utils/utils";
import { Config, HTML, CSS, Constants } from "./app.config";

enableProdMode();

// Static variables
let CachedAliveMessage: IAliveMessage;		// Reuse ALIVE message object

// The APP component
@Component({
	selector: HTML.app,
	template: `
		<div class="${CSS.serverStatus} {{serverStatus}}"
		     style="width:${Config.canvas && Config.canvas.width ? Config.canvas.width + "em" : "100%"};">

			<span id="${HTML.btnChangeSettings}" (click)="onChangeSettings()">&bull; &bull; &bull;</span>

			<img id="${HTML.imgLoading}"
		       *ngIf="serverStatus=='${CSS.serverStatusConnecting}'"
		       src="${CSS.imagesUrl}/${CSS.imgLoading}" />
		</div>

		<${HTML.controllersList}
			[ngStyle]="null|canvasStyles"
			[controllersList]="controllersList">
		</${HTML.controllersList}>
	`
})
export class AppComponent
{
	private isInitialized = false;
	private accessLevel = 0;
	private lastAliveTime = 0;
	private lastServerTickTime = 0;
	private lastSyncControllersListTime = Date.now();
	private layoutThreshold = 600;
	private statusBar: HTMLDivElement | null = null;

	public readonly controllersList = new Subject<IControllerState[]>();
	public serverStatus = CSS.serverStatusOffLine;
	private joinHandle: number | null = null;

	constructor(http: Http, private network: NetworkService<IResponseMessage>, private message: MessageService, private dataStore: DataStoreService<number, IControllerState>)
	{
		if (!Config.filter) Config.filter = "Status, Alarms, Audit, Cycle, Actions";

		CachedAliveMessage = this.message.create("Alive");

		// Check if actionId is ever referred
		let usesAction = false;
		let maps = Config.controllers.default.maps;

		if (maps) {
			maps = Array.isArray(maps) ? maps : [maps];
			usesAction = maps.some(m => m.field === Constants.actionIdField);
		}

		if (!usesAction) {
			const lines = Config.controllers.default.lines;
			if (lines) usesAction = lines.some(line => line.field === Constants.actionIdField);

			if (!usesAction) {
				for (const line of lines) {
					let mp = Config.controllers.default.maps;
					if (mp) {
						mp = Array.isArray(mp) ? mp : [mp];
						if (mp.some(m => m.field === Constants.actionIdField)) {
							usesAction = true;
							break;
						}
					}
				}
			}
		}

		console.log("Uses Actions = " + usesAction);

		// If no actionId referred, remove Actions from filter
		if (!usesAction) {
			Config.filter = Config.filter.split(",").map(f => f.trim()).filter(f => f !== Constants.actionFilter).join(", ");
		}
		console.log("Filters = " + Config.filter);

		// Load text maps if necessary
		if (typeof Config.textMaps === "string") {
			http.get(Config.textMaps).map(r => r.json() as Dictionary<DictionaryWithDefault<Terminal.ITextMap>>).subscribe(json =>
			{
				Config.textMaps = json;
				console.log("Text maps loaded.", Config.textMaps);
			}, console.error.bind(console));
		}

		// Monitor network state
		this.network.onConnection.subscribe(state => this.monitorNetwork(state));

		// Process messages
		this.network.onData
			.do(msg => console.log(msg))
			.subscribe(msg => this.processMessage(msg), console.error.bind(console));

		// Start refresh loop - default to every 1s
		setInterval(() => this.refresh(), Config.settings.RefreshInterval || 1000);
	}

	public onChangeSettings()
	{
		if (!localStorage) return;

		// Prompt for new password
		const pwd = prompt("New password:");
		if (pwd) {
			localStorage.setItem(HTML.password, pwd);
			location.reload(true);
		}
	}

	// Refresh loop
	private refresh()
	{
		// Refresh the network
		this.network.refresh();

		const now = Date.now();

		// Send an ALIVE message once every while
		if (Config.settings.AliveSendInterval && (!this.lastAliveTime || now - this.lastAliveTime > Config.settings.AliveSendInterval)) {
			this.lastAliveTime = now;
			CachedAliveMessage.sequence = this.message.nextSequenceNumber;
			this.network.sendObject(CachedAliveMessage);
		}

		// Send a REQ_CNTRLER_LIST message once every while
		if (Config.settings.SyncControllersListInterval && (now - this.lastSyncControllersListTime) > Config.settings.SyncControllersListInterval) {
			this.lastSyncControllersListTime = now;
			this.network.sendObject(this.message.create("RequestControllersList"));
		}

		// Check if server is alive
		if (Config.settings.ServerAliveTimeout && this.lastServerTickTime && now - this.lastServerTickTime > Config.settings.ServerAliveTimeout) {
			this.network.terminate();
			this.lastServerTickTime = 0;
		}
	}

	// Monitor the state of the WebSocket connection
	private monitorNetwork(state: NetworkState)
	{
		switch (state) {
			case NetworkState.Online: {
				console.log("iChen server is on-line.");
				console.log("Logging on to iChen server...");

				// Loop send JOIN
				if (this.joinHandle !== null) clearInterval(this.joinHandle);

				this.joinHandle = <number><any>setInterval(() =>
				{
					this.network.sendObject(
						this.message.create("Join", {
							language: "EN",
							version: "1.0.0",
							orgId: Config.orgId,
							password: Config.password || "",
							filter: Config.filter
						})
					);
				}, 1000);

				this.serverStatus = CSS.serverStatusOnLine;
				break;
			}
			case NetworkState.Connecting: {
				this.serverStatus = CSS.serverStatusConnecting;
				break;
			}
			case NetworkState.Error: {
				this.serverStatus = CSS.serverStatusError;
				break;
			}
			case NetworkState.Offline: {
				console.warn("Connection to iChen server is dead!");
				this.serverStatus = CSS.serverStatusOffLine;
				break;
			}
		}
	}

	// When the list of controllers change, update it
	private updateControllersList()
	{
		// Create array from cache
		const arr = Array.from(this.dataStore.values());
		this.controllersList.next(arr.sort((a, b) => a.displayName === b.displayName ? 0 : a.displayName < b.displayName ? -1 : 1));
		console.log(`${this.dataStore.size} controller(s) connected.`);
	}

	// Process incoming message
	private processMessage(msg: IResponseMessage)
	{
		const now = Date.now();

		switch (msg.$type) {
			case "Alive": {
				this.lastServerTickTime = now;
				break;
			}

			// Response to JOIN
			case "JoinResponse": {
				if (this.joinHandle !== null) {
					clearInterval(this.joinHandle);
					this.joinHandle = null;
				}

				// Check if successful
				msg.result = msg.result || 0;
				msg.level = msg.level || 0;

				if (msg.result < 100) {
					switch (msg.result) {
						case 99: alert("Each computer IP can only open one Terminal connection to the iChen Server. There is already an active Terminal for this computer, so connection to the iChen Server is denied."); break;
						default: alert(`Connection to the iChen Server is denied. Result code = ${msg.result}.`); break;
					}
					this.serverStatus = CSS.serverStatusDenied;
					break;
				}

				this.accessLevel = msg.level;
				console.log(`Successfully logged on to iChen server. Access level = ${msg.level}.`);
				if (msg.message) console.log(msg.message);

				// Send the REQ_CNTRLER_LIST request
				this.lastSyncControllersListTime = now;
				this.network.sendObject(this.message.create("RequestControllersList"));
				break;
			}

			// New controllers List
			case "ControllersList": {
				// Update the list of controllers into the cache
				mixinDictionaryToMap(msg.data, this.dataStore.getMap());

				// Delete any missing controller from the cache
				for (const id in Array.from(this.dataStore.keys())) {
					if (!msg.data.hasOwnProperty(id)) this.dataStore.delete(id);
				}

				this.updateControllersList();

				// Now the controllers list is obtained, consider the system initialized
				this.isInitialized = true;
				break;
			}

			// Update controller status
			case "ControllerStatus": {
				if (!this.isInitialized) break;
				const id = msg.controllerId;

				// Is there a controller object attached?
				if (msg.controller) {
					const ctrl = msg.controller;

					// Add it into the controllers list if not already there
					if (!this.dataStore.has(id)) {
						const state = {} as IControllerState;
						this.dataStore.set(id, state);
						console.log(`Controller ${ctrl.displayName} [${id}] has joined.`);
					}

					Object.assign(this.dataStore.get(id), ctrl);

					this.updateControllersList();
				}

				// Update status info
				if (!this.dataStore.has(id)) {
					console.error(`No such controller: [${id}]`);
				} else {
					const ctrl = this.dataStore.get(id) as IControllerState;	// Cannot be undefined

					ctrl.lastMessageTime = new Date(now);

					// Is a controller disconnected?
					if (msg.isDisconnected) {
						ctrl.jobMode = "Offline";
						ctrl.opMode = "Offline";
						ctrl.operatorId = 0;
						ctrl.moldId = null;
						ctrl.jobCardId = null;

						this.dataStore.raiseChangeEvent(msg.controllerId);
						break;
					}

					// Skip prior messages arriving out-of-order
					if (ctrl.lastMessageTimeStamp && msg.timestamp < ctrl.lastMessageTimeStamp) break;
					ctrl.lastMessageTimeStamp = msg.timestamp;

					if (msg.displayName) ctrl.displayName = msg.displayName;
					if (msg.opMode) {
						ctrl.opMode = msg.opMode;
						ctrl.lastOpModeChangedTime = msg.timestamp;
					}
					if (msg.jobMode) {
						ctrl.jobMode = msg.jobMode;
						ctrl.lastJobModeChangedTime = msg.timestamp;
					}
					if (msg.jobCardId) {
						ctrl.jobCardId = msg.jobCardId || null;
						ctrl.lastJobCardChangedTIme = msg.timestamp;
					}
					if (msg.operatorId !== undefined) {
						ctrl.operatorId = msg.operatorId || 0;
						ctrl.lastOperatorChangedTime = msg.timestamp;
					}
					if (msg.moldId !== undefined) {
						ctrl.moldId = msg.moldId || null;
						ctrl.lastMoldChangedTime = msg.timestamp;
					}

					if (msg.alarm) {
						const alarm = msg.alarm;

						// Update alarm cache
						if (!ctrl.alarms) ctrl.alarms = {};
						ctrl.alarms[alarm.key] = !!alarm.value;

						// Check the events stack
						ctrl.activeAlarms = ctrl.activeAlarms ? [...ctrl.activeAlarms] : [];
						const index = ctrl.activeAlarms.findIndex(kv => kv.key === alarm.key);

						// Delete the original one if present
						if (index !== undefined) ctrl.activeAlarms.splice(index, 1);

						if (alarm.value) {
							const alm = { key: alarm.key, value: alarm.value, timestamp: msg.timestamp };

							// Push it onto the stack
							if (ctrl.activeAlarms) {
								ctrl.activeAlarms.unshift(alm);
							} else {
								ctrl.activeAlarms = [alm];
							}

							// New alarm - show it
							ctrl.alarm = alm;
						} else {
							// Set the alarm to the latest active one
							ctrl.alarm = (ctrl.activeAlarms && ctrl.activeAlarms.length) ? ctrl.activeAlarms[0] : null;
						}
					}

					this.dataStore.raiseChangeEvent(msg.controllerId);
				}
				break;
			}

			// Update controller action
			case "ControllerAction": {
				if (!this.isInitialized) break;
				const id = msg.controllerId;

				if (!this.dataStore.has(id)) {
					console.error(`No such controller: [${id}]`);
				} else {
					const ctrl = this.dataStore.get(id) as IControllerState;	// Cannot be undefined

					ctrl.actionId = msg.actionId;
					ctrl.lastMessageTime = new Date(now);

					// Skip prior messages arriving out-of-order
					if (ctrl.lastMessageTimeStamp && msg.timestamp < ctrl.lastMessageTimeStamp) break;

					ctrl.lastActionTime = ctrl.lastMessageTimeStamp = msg.timestamp;

					this.dataStore.raiseChangeEvent(msg.controllerId);
				}
				break;
			}

			// Cycle data
			case "CycleData": {
				if (!this.isInitialized) break;
				const id = msg.controllerId;

				if (!this.dataStore.has(id)) {
					console.error(`No such controller: [${id}]`);
				} else {
					const ctrl = this.dataStore.get(id) as IControllerState;	// Cannot be undefined

					ctrl.lastCycleData = msg.data;
					ctrl.lastMessageTime = new Date(now);
					ctrl.lastCycleDataTime = ctrl.lastMessageTimeStamp = msg.timestamp;

					this.dataStore.raiseChangeEvent(msg.controllerId);
				}
				break;
			}
		}
	}
}
