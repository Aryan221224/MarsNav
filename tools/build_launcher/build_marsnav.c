/* Build_MarsNav.exe: double-click to build MarsNav.exe on a Windows PC.
 *
 * It runs build_exe.bat, which sits next to it in the project folder, in a console window and returns its exit code.
 * The batch file does the work (a private Python environment, the packages, PyInstaller, the portable folder); this
 * program only makes the step a double-clickable .exe. Rebuild it with tools/build_launcher/make.sh (MinGW-w64).
 */
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

static int fail(const wchar_t *msg) {
    wprintf(L"\n%ls\n\n", msg);
    system("pause");
    return 1;
}

int wmain(void) {
    wchar_t dir[MAX_PATH];
    DWORD n = GetModuleFileNameW(NULL, dir, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) return fail(L"Build_MarsNav.exe could not find its own folder (the path may be too long).");
    wchar_t *slash = wcsrchr(dir, L'\\');
    if (slash) *slash = L'\0';

    wchar_t bat[MAX_PATH + 32];
    swprintf(bat, MAX_PATH + 32, L"%ls\\build_exe.bat", dir);
    if (GetFileAttributesW(bat) == INVALID_FILE_ATTRIBUTES)
        return fail(L"build_exe.bat is not next to Build_MarsNav.exe.\n"
                    L"Unzip the whole MarsNav project and keep its folders together, then double-click Build_MarsNav.exe again.");

    /* cmd.exe /c ""<folder>\build_exe.bat"": the outer quotes keep paths with spaces intact */
    wchar_t cmd[MAX_PATH * 2 + 64];
    swprintf(cmd, MAX_PATH * 2 + 64, L"cmd.exe /c \"\"%ls\"\"", bat);
    SetConsoleTitleW(L"MarsNav - building MarsNav.exe");

    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof si);
    si.cb = sizeof si;
    ZeroMemory(&pi, sizeof pi);
    if (!CreateProcessW(NULL, cmd, NULL, NULL, FALSE, 0, NULL, dir, &si, &pi))
        return fail(L"Windows could not start build_exe.bat. Double-click build_exe.bat in the same folder instead.");
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return (int)code;
}
