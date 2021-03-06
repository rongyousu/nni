/**
 * Copyright (c) Microsoft Corporation
 * All rights reserved.
 *
 * MIT License
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
 * to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 * BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

'use strict';

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as sqlite3 from 'sqlite3';
import { Deferred } from 'ts-deferred';

import {
    Database,
    MetricDataRecord,
    MetricType,
    TrialJobEvent,
    TrialJobEventRecord
} from '../common/datastore';
import { ExperimentProfile } from '../common/manager';

/* tslint:disable:no-any */

const createTables: string = `
create table TrialJobEvent (timestamp integer, trialJobId text, event text, data text, logPath text);
create index TrialJobEvent_trialJobId on TrialJobEvent(trialJobId);
create index TrialJobEvent_event on TrialJobEvent(event);

create table MetricData (timestamp integer, trialJobId text, parameterId text, type text, sequence integer, data text);
create index MetricData_trialJobId on MetricData(trialJobId);
create index MetricData_type on MetricData(type);

create table ExperimentProfile (
    params text,
    id text,
    execDuration integer,
    startTime integer,
    endTime integer,
    revision integer);
create index ExperimentProfile_id on ExperimentProfile(id);
`;

function loadExperimentProfile(row: any): ExperimentProfile {
    return {
        params: JSON.parse(row.params),
        id: row.id,
        execDuration: row.execDuration,
        startTime: row.startTime === null ? undefined : new Date(row.startTime),
        endTime: row.endTime === null ? undefined : new Date(row.endTime),
        revision: row.revision
    };
}

function loadTrialJobEvent(row: any): TrialJobEventRecord {
    return {
        timestamp: new Date(row.timestamp),
        trialJobId: row.trialJobId,
        event: row.event,
        data: row.data === null ? undefined : row.data,
        logPath: row.logPath === null ? undefined : row.logPath
    };
}

function loadMetricData(row: any): MetricDataRecord {
    return {
        timestamp: new Date(row.timestamp),
        trialJobId: row.trialJobId,
        parameterId: row.parameterId,
        type: row.type,
        sequence: row.sequence,
        data: row.data
    };
}

class SqlDB implements Database {
    private db!: sqlite3.Database;
    private initTask!: Deferred<void>;

    public init(createNew: boolean, dbDir: string): Promise<void> {
        if (this.initTask !== undefined) {
            return this.initTask.promise;
        }
        this.initTask = new Deferred<void>();
        assert(fs.existsSync(dbDir));

        // tslint:disable-next-line:no-bitwise
        const mode: number = createNew ? (sqlite3.OPEN_CREATE | sqlite3.OPEN_READWRITE) : sqlite3.OPEN_READWRITE;
        const dbFileName: string = path.join(dbDir, 'nni.sqlite');

        this.db = new sqlite3.Database(dbFileName, mode, (err: Error | null): void => {
            if (err) {
                this.resolve(this.initTask, err);
            } else {
                if (createNew) {
                    this.db.exec(createTables, (error: Error | null) => {
                        this.resolve(this.initTask, err);
                    });
                } else {
                    this.initTask.resolve();
                }
            }
        });

        return this.initTask.promise;
    }

    public close(): Promise<void> {
        const deferred: Deferred<void> = new Deferred<void>();
        this.db.close((err: Error | null) => { this.resolve(deferred, err); });

        return deferred.promise;
    }

    public storeExperimentProfile(exp: ExperimentProfile): Promise<void> {
        const sql: string = 'insert into ExperimentProfile values (?,?,?,?,?,?)';
        const args: any[] = [
            JSON.stringify(exp.params),
            exp.id,
            exp.execDuration,
            exp.startTime === undefined ? null : exp.startTime.getTime(),
            exp.endTime === undefined ? null : exp.endTime.getTime(),
            exp.revision
        ];

        const deferred: Deferred<void> = new Deferred<void>();
        this.db.run(sql, args, (err: Error | null) => { this.resolve(deferred, err); });

        return deferred.promise;
    }

    public queryExperimentProfile(experimentId: string, revision?: number): Promise<ExperimentProfile[]> {
        let sql: string = '';
        let args: any[] = [];
        if (revision === undefined) {
            sql = 'select * from ExperimentProfile where id=? order by revision DESC';
            args = [experimentId];
        } else {
            sql = 'select * from ExperimentProfile where id=? and revision=?';
            args = [experimentId, revision];
        }

        const deferred: Deferred<ExperimentProfile[]> = new Deferred<ExperimentProfile[]>();
        this.db.all(sql, args, (err: Error | null, rows: any[]) => {
            this.resolve(deferred, err, rows, loadExperimentProfile);
        });

        return deferred.promise;
    }

    public async queryLatestExperimentProfile(experimentId: string): Promise<ExperimentProfile> {
        const profiles: ExperimentProfile[] = await this.queryExperimentProfile(experimentId);

        return profiles[0];
    }

    public storeTrialJobEvent(event: TrialJobEvent, trialJobId: string, data?: string, logPath?: string): Promise<void> {
        const sql: string = 'insert into TrialJobEvent values (?,?,?,?,?)';
        const args: any[] = [Date.now(), trialJobId, event, data, logPath];

        const deferred: Deferred<void> = new Deferred<void>();
        this.db.run(sql, args, (err: Error | null) => { this.resolve(deferred, err); });

        return deferred.promise;
    }

    public queryTrialJobEvent(trialJobId?: string, event?: TrialJobEvent): Promise<TrialJobEventRecord[]> {
        let sql: string = '';
        let args: any[] | undefined;
        if (trialJobId === undefined && event === undefined) {
            sql = 'select * from TrialJobEvent';
        } else if (trialJobId === undefined) {
            sql = 'select * from TrialJobEvent where event=?';
            args = [event];
        } else if (event === undefined) {
            sql = 'select * from TrialJobEvent where trialJobId=?';
            args = [trialJobId];
        } else {
            sql = 'select * from TrialJobEvent where trialJobId=? and event=?';
            args = [trialJobId, event];
        }

        const deferred: Deferred<TrialJobEventRecord[]> = new Deferred<TrialJobEventRecord[]>();
        this.db.all(sql, args, (err: Error | null, rows: any[]) => {
            this.resolve(deferred, err, rows, loadTrialJobEvent);
        });

        return deferred.promise;
    }

    public storeMetricData(trialJobId: string, data: string): Promise<void> {
        const sql: string = 'insert into MetricData values (?,?,?,?,?,?)';
        const json: MetricDataRecord = JSON.parse(data);
        const args: any[] = [Date.now(), json.trialJobId, json.parameterId, json.type, json.sequence, JSON.stringify(json.data)];

        const deferred: Deferred<void> = new Deferred<void>();
        this.db.run(sql, args, (err: Error | null) => { this.resolve(deferred, err); });

        return deferred.promise;
    }

    public queryMetricData(trialJobId?: string, metricType?: MetricType): Promise<MetricDataRecord[]> {
        let sql: string = '';
        let args: any[] | undefined;
        if (metricType === undefined && trialJobId === undefined) {
            sql = 'select * from MetricData';
        } else if (trialJobId === undefined) {
            sql = 'select * from MetricData where type=?';
            args = [metricType];
        } else if (metricType === undefined) {
            sql = 'select * from MetricData where trialJobId=?';
            args = [trialJobId];
        } else {
            sql = 'select * from MetricData where trialJobId=? and type=?';
            args = [trialJobId, metricType];
        }

        const deferred: Deferred<MetricDataRecord[]> = new Deferred<MetricDataRecord[]>();
        this.db.all(sql, args, (err: Error | null, rows: any[]) => {
            this.resolve(deferred, err, rows, loadMetricData);
        });

        return deferred.promise;
    }

    private resolve<T>(
        deferred: Deferred<T[]> | Deferred<void>,
        error: Error | null,
        rows?: any[],
        rowLoader?: (row: any) => T
    ): void {
        if (error !== null) {
            deferred.reject(error);

            return;
        }

        if (rowLoader === undefined) {
            (<Deferred<void>>deferred).resolve();

        } else {
            const data: T[] = [];
            for (const row of (<any[]>rows)) {
                data.push(rowLoader(row));
            }
            (<Deferred<T[]>>deferred).resolve(data);
        }
    }
}

export { SqlDB };
