'use strict';

const catalog = require('../../broker/lib/models/catalog');
const ScheduleManager = require('../../broker/lib/jobs/ScheduleManager');
const Agent = require('../../broker/lib/fabrik/Agent');
const BackupStore = require('../../broker/lib/iaas/BackupStore');

describe('managers', function () {
  describe('BackupService', function () {
    const finishDate = new Date().toISOString();
    const backup_state = {
      state: 'succeeded',
      'stage': 'Backup complete',
      updated_at: finishDate
    };
    const backup_logs = ['Starting Backup ... ', 'Backup Complete.'];
    let sandbox, scheduleStub, getBackupLastOperationStub, getBackupLogsStub, patchBackupFileStub, getFileStub;
    before(function () {
      sandbox = sinon.sandbox.create();
      scheduleStub = sinon.stub(ScheduleManager, 'schedule', () => Promise.resolve({}));
      getBackupLastOperationStub = sandbox.stub(Agent.prototype, 'getBackupLastOperation');
      getBackupLastOperationStub.withArgs().returns(Promise.resolve(backup_state));
      getBackupLogsStub = sandbox.stub(Agent.prototype, 'getBackupLogs');
      getBackupLogsStub.withArgs().returns(Promise.resolve(backup_logs));
      patchBackupFileStub = sandbox.stub(BackupStore.prototype, 'patchBackupFile');
      patchBackupFileStub.withArgs().returns(Promise.resolve({}));
      getFileStub = sandbox.stub(BackupStore.prototype, 'getBackupFile');
      getFileStub.withArgs().returns(Promise.resolve({
        backup_guid: backup_guid,
        state: 'processing',
        agent_ip: mocks.agent.ip
      }));
    });
    afterEach(function () {
      mocks.reset();
      scheduleStub.reset();
      getBackupLastOperationStub.reset();
      getBackupLogsStub.reset();
      patchBackupFileStub.reset();
      getFileStub.reset();
    });
    after(function () {
      scheduleStub.restore();
      getBackupLastOperationStub.restore();
      getBackupLogsStub.restore();
      patchBackupFileStub.restore();
      getFileStub.restore();
    });

    const backup_guid = '071acb05-66a3-471b-af3c-8bbf1e4180be';
    const space_guid = 'e7c0a437-7585-4d75-addf-aa4d45b49f3a';
    const service_id = '24731fb8-7b84-4f57-914f-c3d55d793dd4';
    const plan_id = 'bc158c9a-7934-401e-94ab-057082a5073f';
    const deployment_name = 'service-fabrik-0021-b4719e7c-e8d3-4f7f-c515-769ad1c3ebfa';
    const instance_id = 'b4719e7c-e8d3-4f7f-c515-769ad1c3ebfa';
    const organization_guid = 'b8cbbac8-6a20-42bc-b7db-47c205fccf9a';
    const BackupService = require('../../managers/backup-manager/BackupService');
    const plan = catalog.getPlan(plan_id);

    const manager = new BackupService(plan);
    it('Should start backup successfully', function () {
      const context = {
        platform: 'cloudfoundry',
        organization_guid: organization_guid,
        space_guid: space_guid
      };
      const opts = {
        guid: backup_guid,
        deployment: deployment_name,
        instance_guid: instance_id,
        plan_id: plan_id,
        service_id: service_id,
        context: context
      };
      // const type = 'online';
      mocks.director.getDeploymentVms(deployment_name);
      mocks.director.getDeploymentInstances(deployment_name);
      mocks.agent.getInfo();
      mocks.agent.startBackup();
      mocks.apiServerEventMesh.nockPatchResourceRegex('backup', 'defaultbackup', {
        status: {
          state: 'in_progress'
        }
      }, 2);
      mocks.apiServerEventMesh.nockGetResourceRegex('backup', 'defaultbackup', {
        status: {
          state: 'in_progress',
          response: '{}'
        }
      });
      return manager.startBackup(opts)
        .then(() => {
          expect(scheduleStub.callCount).to.eql(1);
          mocks.verify();
        });
    });

    it('Should get backup operation state successfully', function () {
      const agent_ip = mocks.agent.ip;
      const context = {
        platform: 'cloudfoundry',
        organization_guid: organization_guid,
        space_guid: space_guid
      };
      const opts = {
        deployment: deployment_name,
        instance_guid: instance_id,
        agent_ip: agent_ip,
        context: context
      };
      return manager.getOperationState('backup', opts)
        .then((res) => {
          expect(res.description).to.eql(`Backup deployment ${deployment_name} succeeded at ${finishDate}`);
          expect(res.state).to.eql('succeeded');
          expect(getBackupLastOperationStub.callCount).to.eql(1);
          expect(getBackupLastOperationStub.firstCall.args[0]).to.eql(opts.agent_ip);
          expect(getBackupLogsStub.callCount).to.eql(1);
          expect(getBackupLogsStub.firstCall.args[0]).to.eql(opts.agent_ip);
          expect(patchBackupFileStub.callCount).to.eql(1);
          mocks.verify();
        });
    });

    it('Should abort last backup successfully', function () {
      const agent_ip = mocks.agent.ip;
      const context = {
        platform: 'cloudfoundry',
        organization_guid: organization_guid,
        space_guid: space_guid
      };
      const opts = {
        service_id: service_id,
        deployment: deployment_name,
        instance_guid: instance_id,
        agent_ip: agent_ip,
        context: context,
        guid: backup_guid
      };
      mocks.apiServerEventMesh.nockPatchResourceRegex('backup', 'defaultbackup', {
        status: {
          state: 'aborting'
        }
      });
      mocks.agent.abortBackup();
      return manager.abortLastBackup(opts, true)
        .then((res) => {
          expect(res.state).to.eql('aborting');
          expect(getFileStub.callCount).to.eql(1);
          expect(getFileStub.firstCall.args[0]).to.eql({
            service_id: service_id,
            tenant_id: space_guid,
            instance_guid: instance_id
          });
          mocks.verify();
        });
    });

  });
});