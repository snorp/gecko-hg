# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this file,
# You can obtain one at http://mozilla.org/MPL/2.0/.

import re
import os
import shutil
import tempfile
import time
import traceback

from devicemanager import DeviceManager, DMError
from mozprocess import ProcessHandler
import mozfile
import mozlog


class DeviceManagerIOS(DeviceManager):
    """
    Implementation of DeviceManager interface that uses the `ios-deploy`
    command to communicate with an iOS device.
    """
    default_timeout = 300

    def __init__(self,
                 appBundle,
                 logLevel=mozlog.ERROR,
                 iosDeployPath='ios-deploy',
                 deviceID=None,
                 retryLimit=5,
                 **kwargs):
        DeviceManager.__init__(self, logLevel=logLevel)
        self._appBundle = appBundle
        # the path to ios-deploy, or 'ios-deploy' to assume that it's on the PATH
        self._idPath = iosDeployPath
        self.retryLimit = retryLimit
        self._deviceID = deviceID
        self._tempDir = None

        # verify that we can run the adb command. can't continue otherwise
        self._verifyIOSDeploy()

    def shell(self, cmd, outputfile, env=None, cwd=None, timeout=None, root=False):
        if cmd[0] != self._appBundle:
            raise DMError('Trying to run a bad command: %s' % cmd[0])
        # all output should be in stdout
        args = [
            self._idPath,
            '--bundle', self._appBundle,
            '--noinstall', '--noninteractive',
        ]
        if self._deviceID:
            args.extend(['--id', self._deviceID])
        #XXX: is this enough escaping?
        escaped = []
        for c in cmd[1:]:
            if c.startswith('-'):
                escaped.append('\\' + c)
            elif ' ' in c:
                # oh the humanity
                escaped.append('"%s"' % c.replace('"', '\\\\"'))
            else:
                escaped.append(c)
        args.extend(['--args', ' '.join(escaped)])

        def _raise():
            raise DMError("Timeout exceeded for shell call")

        self._logger.debug("shell - command: %s" % ' '.join(args))
        def handleOutput(line):
            self._log(line)
            if hasattr(handleOutput, 'lldb_done'):
                if line.startswith("Process ") and line.endswith(" stopped"):
                    # This is crappy
                    handleOutput.skipLines = 7
                else:
                    n = getattr(handleOutput, 'skipLines', 0)
                    if n == 0:
                        outputfile.write(line)
                    else:
                        handleOutput.skipLines = n - 1
            elif line == "(lldb)     autoexit":
                handleOutput.lldb_done = True
        proc = ProcessHandler(args,
                              processOutputLine=handleOutput,
                              onTimeout=_raise,
                              storeOutput=False)

        if not timeout:
            # We are asserting that all commands will complete in this time unless otherwise specified
            timeout = self.default_timeout

        timeout = int(timeout)
        proc.run(timeout)
        ret = proc.wait()
        return ret

    def _relPath(self, path):
        if path.startswith(self.deviceRoot):
            return path[len(self.deviceRoot):]
        return path

    def pushFile(self, localname, destname, retryLimit=None, createDir=True):
        rel_dest = self._relPath(destname)
        proc = self._runCmd(['--upload', os.path.realpath(localname), '--to', rel_dest],
                retryLimit=retryLimit)
        if proc.returncode != 0:
            raise DMError("Error pushing file %s -> %s; output: %s" % (localname, destname, proc.output))

    def mkDir(self, name):
        self._checkCmd(['--mkdir', self._relPath(name)])

    def mkDirs(self, name):
        return self.mkDir(name)

    def pushDir(self, localDir, remoteDir, retryLimit=None, timeout=None):
        return self.pushFile(localDir, remoteDir)

    def dirExists(self, remotePath):
        #XXX: Hacky, can't really tell if this is a dir or file.
        data = self._runCmd(['--list']).output
        rel_path = self.relPath(remotePath)

        return ('/' + rel_path) in data.splitlines()

    def fileExists(self, filepath):
        #XXX: see above
        return self.dirExists(filepath)

    def removeFile(self, filename):
        self._checkCmd(['--rm', self.relPath(filename)])

    def removeDir(self, remoteDir):
        #XXX: doesn't support recursive removal
        return self.removeFile(remoteDir)

    def moveTree(self, source, destination):
        raise DMError("Not supported")

    def copyTree(self, source, destination):
        raise DMError("Not supported")

    def listFiles(self, rootdir):
        #TODO: fix --list to accept an argument
        full_list = self._runCmd(['--list']).output
        rel_path = self.relPath(rootdir)
        data = []
        for line in full_list:
            path = line.rstrip('\r\n')[1:]
            if path.startswith(rel_path):
                data.append(path[len(rel_path):])
        return data

    def getProcessList(self):
        raise DMError("Not supported")

    def killProcess(self, appname, sig=None):
        raise DMError("Not supported")

    def _runPull(self, remoteFile, localFile):
        """
        Pulls remoteFile from device to host
        """
        raise DMError("Not yet supported")

    def pullFile(self, remoteFile, offset=None, length=None):
        with mozfile.NamedTemporaryFile() as tf:
            self._runPull(remoteFile, tf.name)
            # we need to reopen the file to get the written contents
            with open(tf.name) as tf2:
                # ADB pull does not support offset and length, but we can
                # instead read only the requested portion of the local file
                if offset is not None and length is not None:
                    tf2.seek(offset)
                    return tf2.read(length)
                elif offset is not None:
                    tf2.seek(offset)
                    return tf2.read()
                else:
                    return tf2.read()

    def getFile(self, remoteFile, localFile):
        self._runPull(remoteFile, localFile)

    def getDirectory(self, remoteDir, localDir, checkDir=True):
        raise DMError("Not yet supported")

    def validateFile(self, remoteFile, localFile):
        md5Remote = self._getRemoteHash(remoteFile)
        md5Local = self._getLocalHash(localFile)
        if md5Remote is None or md5Local is None:
            return None
        return md5Remote == md5Local

    def _getRemoteHash(self, remoteFile):
        """
        Return the md5 sum of a file on the device
        """
        with tempfile.NamedTemporaryFile() as f:
            self._runPull(remoteFile, f.name)

            return self._getLocalHash(f.name)

    def _setupDeviceRoot(self, deviceRoot):
        return self._runCmd(['--print-path']).output[0]

    def getTempDir(self):
        # Cache result to speed up operations depending
        # on the temporary directory.
        if not self._tempDir:
            self._tempDir = "%s/Library/Caches" % self.deviceRoot

        return self._tempDir

    def updateApp(self, appBundlePath, **kwargs):
        raise DMError("Not yet supported")

    def getInfo(self, directive=None):
        return {}

    def uninstallApp(self, appName, installPath=None):
        raise DMError("Not yet supported")

    def uninstallAppAndReboot(self, appName, installPath=None):
        self.uninstallApp(appName)
        self.reboot()

    def chmodDir(self, remoteDir, mask="777"):
        # just ignore this for now
        pass

    def _runCmd(self, args, retryLimit=None):
        """
        Runs a command using ios-deploy

        returns: instance of ProcessHandler
        """
        retryLimit = retryLimit or self.retryLimit
        finalArgs = [self._idPath, '--bundle', self._appBundle]
        if self._deviceID:
            finalArgs.extend(['--id', self._deviceID])
        finalArgs.extend(args)
        self._logger.debug("_runCmd - command: %s" % ' '.join(finalArgs))
        retries = 0
        while retries < retryLimit:
            proc = ProcessHandler(finalArgs, storeOutput=True,
                    processOutputLine=self._log)
            proc.run()
            proc.returncode = proc.wait()
            if proc.returncode == None:
                proc.kill()
                retries += 1
            else:
                return proc

    # timeout is specified in seconds, and if no timeout is given,
    # we will run until we hit the default_timeout specified in the __init__
    def _checkCmd(self, args, timeout=None, retryLimit=None):
        """
        Runs a command using ios-deploy and waits for the command to finish.
        If timeout is specified, the process is killed after <timeout> seconds.

        returns: returncode from process
        """
        retryLimit = retryLimit or self.retryLimit
        finalArgs = [self._idPath, '--bundle', self._appBundle]
        if self._deviceID:
            finalArgs.extend(['--id', self._deviceID])
        finalArgs.extend(args)
        self._logger.debug("_checkCmd - command: %s" % ' '.join(finalArgs))
        if not timeout:
            # We are asserting that all commands will complete in this
            # time unless otherwise specified
            timeout = self.default_timeout

        timeout = int(timeout)
        retries = 0
        while retries < retryLimit:
            proc = ProcessHandler(finalArgs, processOutputLine=self._log)
            proc.run(timeout=timeout)
            ret_code = proc.wait()
            if ret_code == None:
                proc.kill()
                retries += 1
            else:
                return ret_code

        raise DMError("Timeout exceeded for _checkCmd call after %d retries." % retries)

    def _verifyIOSDeploy(self):
        """
        Check to see if ios-deploy can be executed.
        """
        if self._idPath != 'ios-deploy':
            if not os.access(self._idPath, os.X_OK):
                raise DMError("invalid ios-deploy path, or ios-deploy not executable: %s" % self._idPath)

        try:
            self._checkCmd(["--version"])
        except os.error, err:
            raise DMError("unable to execute ios-deploy (%s)" % err)

    def _verifyDevice(self):
        args = ["--detect"]
        if self._deviceID:
            args.extend("--id", self._deviceID)

        # Check to see if we can connect to device
        if not self._checkCmd(args) == 0:
            raise DMError("unable to connect to device")
