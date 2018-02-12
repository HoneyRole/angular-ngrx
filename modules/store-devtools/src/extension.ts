import { Inject, Injectable, InjectionToken } from '@angular/core';
import { Action } from '@ngrx/store';
import { Observable } from 'rxjs/Observable';
import { empty } from 'rxjs/observable/empty';
import { filter } from 'rxjs/operator/filter';
import { map } from 'rxjs/operator/map';
import { share } from 'rxjs/operator/share';
import { switchMap } from 'rxjs/operator/switchMap';
import { takeUntil } from 'rxjs/operator/takeUntil';

import { STORE_DEVTOOLS_CONFIG, StoreDevtoolsConfig } from './config';
import { LiftedState } from './reducer';
import { PerformAction } from './actions';
import { applyOperators, unliftState } from './utils';

export const ExtensionActionTypes = {
  START: 'START',
  DISPATCH: 'DISPATCH',
  STOP: 'STOP',
  ACTION: 'ACTION',
};

export const REDUX_DEVTOOLS_EXTENSION = new InjectionToken<
  ReduxDevtoolsExtension
>('Redux Devtools Extension');

export interface ReduxDevtoolsExtensionConnection {
  subscribe(listener: (change: any) => void): void;
  unsubscribe(): void;
  send(action: any, state: any): void;
  init(state?: any): void;
  error(any: any): void;
}
export interface ReduxDevtoolsExtensionConfig {
  features?: object | boolean;
  name: string | undefined;
  instanceId: string;
  maxAge?: number;
  actionSanitizer?: (action: Action, id: number) => Action;
}

export interface ReduxDevtoolsExtension {
  connect(
    options: ReduxDevtoolsExtensionConfig
  ): ReduxDevtoolsExtensionConnection;
  send(
    action: any,
    state: any,
    options: StoreDevtoolsConfig,
    instanceId?: string
  ): void;
}

@Injectable()
export class DevtoolsExtension {
  private instanceId = `ngrx-store-${Date.now()}`;
  private devtoolsExtension: ReduxDevtoolsExtension;
  private extensionConnection: ReduxDevtoolsExtensionConnection;

  liftedActions$: Observable<any>;
  actions$: Observable<any>;

  constructor(
    @Inject(REDUX_DEVTOOLS_EXTENSION) devtoolsExtension: ReduxDevtoolsExtension,
    @Inject(STORE_DEVTOOLS_CONFIG) private config: StoreDevtoolsConfig
  ) {
    this.devtoolsExtension = devtoolsExtension;
    this.createActionStreams();
  }

  notify(action: Action, state: LiftedState) {
    if (!this.devtoolsExtension) {
      return;
    }

    // Check to see if the action requires a full update of the liftedState.
    // If it is a simple action generated by the user's app, only send the
    // action and the current state (fast).
    //
    // A full liftedState update (slow: serializes the entire liftedState) is
    // only required when:
    //   a) redux-devtools-extension fires the @@Init action (ignored by
    //      @ngrx/store-devtools)
    //   b) an action is generated by an @ngrx module (e.g. @ngrx/effects/init
    //      or @ngrx/store/update-reducers)
    //   c) the state has been recomputed due to time-traveling
    //   d) any action that is not a PerformAction to err on the side of
    //      caution.
    if (action instanceof PerformAction) {
      const currentState = unliftState(state);
      this.extensionConnection.send(action.action, currentState);
    } else {
      // Requires full state update;
      this.devtoolsExtension.send(null, state, this.config, this.instanceId);
    }
  }

  private createChangesObservable(): Observable<any> {
    if (!this.devtoolsExtension) {
      return empty();
    }

    return new Observable(subscriber => {
      let extensionOptions: ReduxDevtoolsExtensionConfig = {
        instanceId: this.instanceId,
        name: this.config.name,
        features: this.config.features,
        actionSanitizer: this.config.actionSanitizer,
      };
      if (this.config.maxAge !== false /* support === 0 */) {
        extensionOptions.maxAge = this.config.maxAge;
      }
      const connection = this.devtoolsExtension.connect(extensionOptions);
      this.extensionConnection = connection;
      connection.init();

      connection.subscribe((change: any) => subscriber.next(change));
      return connection.unsubscribe;
    });
  }

  private createActionStreams() {
    // Listens to all changes based on our instanceId
    const changes$ = share.call(this.createChangesObservable());

    // Listen for the start action
    const start$ = filter.call(
      changes$,
      (change: any) => change.type === ExtensionActionTypes.START
    );

    // Listen for the stop action
    const stop$ = filter.call(
      changes$,
      (change: any) => change.type === ExtensionActionTypes.STOP
    );

    // Listen for lifted actions
    const liftedActions$ = applyOperators(changes$, [
      [filter, (change: any) => change.type === ExtensionActionTypes.DISPATCH],
      [map, (change: any) => this.unwrapAction(change.payload)],
    ]);

    // Listen for unlifted actions
    const actions$ = applyOperators(changes$, [
      [filter, (change: any) => change.type === ExtensionActionTypes.ACTION],
      [map, (change: any) => this.unwrapAction(change.payload)],
    ]);

    const actionsUntilStop$ = takeUntil.call(actions$, stop$);
    const liftedUntilStop$ = takeUntil.call(liftedActions$, stop$);

    // Only take the action sources between the start/stop events
    this.actions$ = switchMap.call(start$, () => actionsUntilStop$);
    this.liftedActions$ = switchMap.call(start$, () => liftedUntilStop$);
  }

  private unwrapAction(action: Action) {
    return typeof action === 'string' ? eval(`(${action})`) : action;
  }
}
