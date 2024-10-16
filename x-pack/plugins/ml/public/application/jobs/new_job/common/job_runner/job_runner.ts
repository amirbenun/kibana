/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { BehaviorSubject } from 'rxjs';
import type { MlApiServices } from '../../../../services/ml_api_service';
import type { MlJobService } from '../../../../services/job_service';
import type { JobCreator } from '../job_creator';
import type { DatafeedId, JobId } from '../../../../../../common/types/anomaly_detection_jobs';
import { DATAFEED_STATE } from '../../../../../../common/constants/states';

const REFRESH_INTERVAL_MS = 250;
const NODE_ASSIGNMENT_CHECK_REFRESH_INTERVAL_MS = 2000;
const TARGET_PROGRESS_DELTA = 2;
const REFRESH_RATE_ADJUSTMENT_DELAY_MS = 2000;

type Progress = number;
export type ProgressSubscriber = (progress: number) => void;
export type JobAssignmentSubscriber = (assigned: boolean) => void;

export class JobRunner {
  private _mlApiServices: MlApiServices;
  private _mlJobService: MlJobService;
  private _jobId: JobId;
  private _datafeedId: DatafeedId;
  private _start: number = 0;
  private _end: number = 0;
  private _datafeedState: DATAFEED_STATE = DATAFEED_STATE.STOPPED;
  private _refreshInterval: number = REFRESH_INTERVAL_MS;

  private _progress$: BehaviorSubject<Progress>;
  private _percentageComplete: Progress = 0;
  private _stopRefreshPoll: {
    stop: boolean;
  };
  private _subscribers: ProgressSubscriber[];

  private _datafeedStartTime: number = 0;
  private _performRefreshRateAdjustment: boolean = false;
  private _jobAssignedToNode: boolean = false;
  private _jobAssignedToNode$: BehaviorSubject<boolean>;

  constructor(jobCreator: JobCreator) {
    this._mlApiServices = jobCreator.mlApiServices;
    this._mlJobService = jobCreator.mlJobService;
    this._jobId = jobCreator.jobId;
    this._datafeedId = jobCreator.datafeedId;
    this._start = jobCreator.start;
    this._end = jobCreator.end;
    this._percentageComplete = 0;
    this._stopRefreshPoll = jobCreator.stopAllRefreshPolls;

    this._progress$ = new BehaviorSubject(this._percentageComplete);
    this._jobAssignedToNode$ = new BehaviorSubject(this._jobAssignedToNode);
    this._subscribers = jobCreator.subscribers;
  }

  public get datafeedState(): DATAFEED_STATE {
    return this._datafeedState;
  }

  public set refreshInterval(v: number) {
    this._refreshInterval = v;
  }

  public resetInterval() {
    this._refreshInterval = REFRESH_INTERVAL_MS;
  }

  private async openJob(): Promise<void> {
    try {
      const { node }: { node?: string } = await this._mlJobService.openJob(this._jobId);
      this._jobAssignedToNode = node !== undefined && node.length > 0;
      this._jobAssignedToNode$.next(this._jobAssignedToNode);
    } catch (error) {
      throw error;
    }
  }

  // start the datafeed and then start polling for progress
  // the complete percentage is added to an observable
  // so all pre-subscribed listeners can follow along.
  private async _startDatafeed(
    start: number | undefined,
    end: number | undefined,
    pollProgress: boolean
  ): Promise<boolean> {
    try {
      this._datafeedStartTime = Date.now();
      // link the _subscribers list from the JobCreator
      // to the progress BehaviorSubject.
      const subscriptions =
        pollProgress === true ? this._subscribers.map((s) => this._progress$.subscribe(s)) : [];

      await this.openJob();
      const { started } = await this._mlJobService.startDatafeed(
        this._datafeedId,
        this._jobId,
        start,
        end
      );

      this._datafeedState = DATAFEED_STATE.STARTED;
      this._percentageComplete = 0;

      const checkProgress = async () => {
        const { isRunning, progress: prog, isJobClosed } = await this.getProgress();

        // if the progress has reached 100% but the job is still running,
        // dial the progress back to 99 to avoid any post creation buttons from
        // appearing as they only rely on the progress.
        const progress =
          prog === 100 && (isRunning === true || isJobClosed === false) ? prog - 1 : prog;

        this._adjustRefreshInterval(progress);
        this._percentageComplete = progress;
        this._progress$.next(this._percentageComplete);

        if ((isRunning === true || isJobClosed === false) && this._stopRefreshPoll.stop === false) {
          setTimeout(async () => {
            if (this._stopRefreshPoll.stop === false) {
              await checkProgress();
            }
          }, this._refreshInterval);
        } else {
          // job has finished running, set progress to 100%
          // it may be lower than 100 on completion as the progress
          // is calculated based on latest_record_timestamp which may be earlier
          // than the end date supplied to the datafeed
          this._progress$.next(100);
          // unsubscribe everyone
          subscriptions.forEach((s) => s.unsubscribe());
        }
      };

      const checkJobIsAssigned = async () => {
        this._jobAssignedToNode = await this._isJobAssigned();
        this._jobAssignedToNode$.next(this._jobAssignedToNode);
        if (this._jobAssignedToNode === true) {
          await checkProgress();
        } else {
          setTimeout(async () => {
            if (this._stopRefreshPoll.stop === false) {
              await checkJobIsAssigned();
            }
          }, NODE_ASSIGNMENT_CHECK_REFRESH_INTERVAL_MS);
        }
      };
      // wait for the first check to run and then return success.
      // all subsequent checks will update the observable
      if (pollProgress === true) {
        if (this._jobAssignedToNode === true) {
          await checkProgress();
        } else {
          await checkJobIsAssigned();
        }
      }

      return started;
    } catch (error) {
      throw error;
    }
  }

  private _adjustRefreshInterval(progress: number) {
    if (this._performRefreshRateAdjustment === false) {
      // for the first couple of seconds of the job running, don't
      // adjust the refresh interval
      const timeDeltaMs = Date.now() - this._datafeedStartTime;
      if (timeDeltaMs > REFRESH_RATE_ADJUSTMENT_DELAY_MS) {
        this._performRefreshRateAdjustment = true;
      } else {
        return;
      }
    }

    const progressDelta = progress - this._percentageComplete;
    if (progressDelta !== 0) {
      // adjust the refresh interval so that it produces a change in percentage
      // that is close to the target
      this._refreshInterval = Math.floor(
        this._refreshInterval * (TARGET_PROGRESS_DELTA / progressDelta)
      );

      // don't let the interval fall below the initial default.
      if (this._refreshInterval < REFRESH_INTERVAL_MS) {
        this._refreshInterval = REFRESH_INTERVAL_MS;
      }
    }
  }

  private async _isJobAssigned(): Promise<boolean> {
    const { jobs } = await this._mlApiServices.getJobStats({ jobId: this._jobId });
    return jobs.length > 0 && jobs[0].node !== undefined;
  }

  public async startDatafeed() {
    return await this._startDatafeed(this._start, this._end, true);
  }

  public async startDatafeedInRealTime(continueJob: boolean) {
    // if continuing a job, set the start to be the end date
    const start = continueJob ? this._end : this._start;
    return await this._startDatafeed(start, undefined, false);
  }

  public async getProgress(): Promise<{
    progress: Progress;
    isRunning: boolean;
    isJobClosed: boolean;
  }> {
    return await this._mlApiServices.jobs.getLookBackProgress(this._jobId, this._start, this._end);
  }

  public subscribeToProgress(func: ProgressSubscriber) {
    this._progress$.subscribe(func);
  }

  public async isRunning(): Promise<boolean> {
    const { isRunning } = await this.getProgress();
    return isRunning;
  }

  public isJobAssignedToNode() {
    return this._jobAssignedToNode;
  }

  public subscribeToJobAssignment(func: JobAssignmentSubscriber) {
    return this._jobAssignedToNode$.subscribe(func);
  }
}
