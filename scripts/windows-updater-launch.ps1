# Run the per-user updater as a non-elevated process, including on headless CI
# runners. Tauri's elevated RunAsUser path requires an Explorer shell; its normal
# per-user path does not. Do not replace the installer's actual relaunch in tests.
[CmdletBinding()]
param([string]$Executable, [switch]$SelfTest)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Requires a disposable GitHub Actions runner' }
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Security.AccessControl;
using System.Security.Principal;
public static class UpdaterTestLauncher {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
        public int cb; public string reserved, desktop, title;
        public int x, y, width, height, xChars, yChars, fill, flags;
        public short show, reservedSize; public IntPtr reservedPtr, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)]
    struct TOKEN_MANDATORY_LABEL { public IntPtr sid; public uint attributes; }
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int info, out int value, int size, out int returned);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool CreateRestrictedToken(IntPtr token, uint flags, uint disableCount, IntPtr disable, uint deleteCount, IntPtr delete, uint restrictCount, IntPtr restrict, out IntPtr result);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSidToSid(string text, out IntPtr sid);
    [DllImport("advapi32.dll")] static extern uint GetLengthSid(IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int info, ref TOKEN_MANDATORY_LABEL label, int size);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessAsUser(IntPtr token, string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetUserObjectSecurity(IntPtr handle, ref uint info, byte[] descriptor, uint size, out uint needed);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetUserObjectSecurity(IntPtr handle, ref uint info, byte[] descriptor);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint size, out uint needed);
    [DllImport("advapi32.dll", EntryPoint = "SetTokenInformation", SetLastError = true)] static extern bool SetTokenDefaultDacl(IntPtr token, int info, ref IntPtr acl, int size);
    static string GrantDesktopAccess(IntPtr handle, SecurityIdentifier user) {
        // The runner's station/desktop may grant access only to Administrators.
        // LUA_TOKEN disables that group. Preserve the ACL and explicitly grant
        // this same user access, rather than opening access to Everyone.
        uint info = 4, needed;
        GetUserObjectSecurity(handle, ref info, null, 0, out needed);
        var bytes = new byte[needed];
        Check(GetUserObjectSecurity(handle, ref info, bytes, needed, out needed));
        var descriptor = new RawSecurityDescriptor(bytes, 0);
        if (descriptor.DiscretionaryAcl != null) {
            descriptor.DiscretionaryAcl.InsertAce(descriptor.DiscretionaryAcl.Count,
                new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, 0x10000000, user, false, null));
            bytes = new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(bytes, 0);
            Check(SetUserObjectSecurity(handle, ref info, bytes));
        }
        var name = new StringBuilder(256);
        Check(GetUserObjectInformation(handle, 2, name, 512, out needed));
        return name.ToString();
    }
    static void SetChildDefaultDacl(IntPtr token, SecurityIdentifier user) {
        // Objects created during DLL initialization must also be accessible
        // without the disabled Administrators SID from the original token.
        var descriptor = new RawSecurityDescriptor("D:(A;;GA;;;SY)(A;;GA;;;" + user.Value + ")");
        var acl = descriptor.DiscretionaryAcl;
        var bytes = new byte[acl.BinaryLength]; acl.GetBinaryForm(bytes, 0);
        IntPtr memory = Marshal.AllocHGlobal(bytes.Length);
        try {
            Marshal.Copy(bytes, 0, memory, bytes.Length);
            Check(SetTokenDefaultDacl(token, 6, ref memory, IntPtr.Size));
        } finally { Marshal.FreeHGlobal(memory); }
    }
    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static int Elevation(IntPtr token) { int value, returned; Check(GetTokenInformation(token, 20, out value, 4, out returned)); return value; }
    public static uint Run(string executable, string arguments) {
        IntPtr original = IntPtr.Zero, restricted = IntPtr.Zero, sid = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        try {
            Check(OpenProcessToken(GetCurrentProcess(), 0xF01FF, out original));
            // LUA_TOKEN removes administrator privileges while retaining the
            // same user/profile and access to the per-user installation.
            Check(CreateRestrictedToken(original, 4, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out restricted));
            Check(ConvertStringSidToSid("S-1-16-8192", out sid)); // Medium integrity
            var label = new TOKEN_MANDATORY_LABEL { sid = sid, attributes = 0x20 };
            Check(SetTokenInformation(restricted, 25, ref label, Marshal.SizeOf(label) + (int)GetLengthSid(sid)));
            if (Elevation(restricted) != 0) throw new Exception("Smoke process still has an elevated token");
            var user = WindowsIdentity.GetCurrent().User;
            SetChildDefaultDacl(restricted, user);
            var station = GrantDesktopAccess(GetProcessWindowStation(), user);
            var desktop = GrantDesktopAccess(GetThreadDesktop(GetCurrentThreadId()), user);
            var startup = new STARTUPINFO(); startup.cb = Marshal.SizeOf(startup);
            startup.desktop = station + "\\" + desktop;
            // A null environment inherits the scenario variables from this
            // launcher. lpApplicationName avoids ambiguous paths with spaces.
            Check(CreateProcessAsUser(restricted, executable, new StringBuilder("\"" + executable + "\" " + arguments), IntPtr.Zero, IntPtr.Zero, false, 0x08000000, IntPtr.Zero, null, ref startup, out process));
            var state = Environment.GetEnvironmentVariable("PRISM_TEST_ROOT");
            if (!String.IsNullOrEmpty(state)) System.IO.File.WriteAllText(System.IO.Path.Combine(state, "launcher.json"), "{\"pid\":" + process.pid + ",\"elevated\":false}");
            if (WaitForSingleObject(process.process, 180000) != 0) throw new Exception("Smoke process did not exit within three minutes");
            uint code; Check(GetExitCodeProcess(process.process, out code)); return code;
        } finally {
            if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
            if (process.process != IntPtr.Zero) CloseHandle(process.process);
            if (sid != IntPtr.Zero) LocalFree(sid);
            if (restricted != IntPtr.Zero) CloseHandle(restricted);
            if (original != IntPtr.Zero) CloseHandle(original);
        }
    }
}
'@
try {
    if ($SelfTest) {
        $root = Join-Path $env:RUNNER_TEMP 'updater launcher test'
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        $probe = Join-Path $root 'probe.ps1'
        Remove-Item -LiteralPath (Join-Path $root 'probe-ok') -Force -ErrorAction SilentlyContinue
        @'
$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 10 }
if ($env:PRISM_TEST_SENTINEL -ne 'inherited context') { exit 11 }
[IO.File]::WriteAllText((Join-Path $env:PRISM_TEST_ROOT 'probe-ok'), 'ok')
'@ | Set-Content -Path $probe
        $env:PRISM_TEST_ROOT = $root
        $env:PRISM_TEST_SENTINEL = 'inherited context'
        $code = [UpdaterTestLauncher]::Run((Join-Path $PSHOME 'powershell.exe'), ('-NoProfile -NonInteractive -File "' + $probe + '"'))
        if ($code -ne 0 -or !(Test-Path (Join-Path $root 'probe-ok'))) { throw ('Unelevated launcher self-test failed: {0} (0x{0:X8})' -f $code) }
        Write-Host 'PASS: non-elevated child, inherited environment, paths with spaces'
        exit 0
    }
    if (!$Executable) { throw 'Executable is required' }
    $code = [UpdaterTestLauncher]::Run($Executable, '')
    exit $code
} catch {
    if ($env:PRISM_TEST_ROOT) { [IO.File]::WriteAllText((Join-Path $env:PRISM_TEST_ROOT 'error'), $_.Exception.ToString()) }
    throw
}
