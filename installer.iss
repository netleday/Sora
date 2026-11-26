; Inno Setup 6 Script for Sora v2.0 (by netleday)
#define MyAppName "Sora"
#define MyAppVersion "2.0.0"
#define MyAppPublisher "netleday"
#define MyAppURL "https://github.com/netleday/Sora"
#define MyAppExeName "sora.exe"

[Setup]
AppId={{8F2A91B4-4E12-4F90-9A1B-74C98022E633}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={localappdata}\Programs\Sora
DefaultGroupName=Sora
AllowNoIcons=yes
OutputDir=dist
OutputBaseFilename=Sora-Setup-v2.0
SetupIconFile=src-tauri\icons\icon.ico
WizardImageFile=installer_src\wizard_banner.bmp
WizardSmallImageFile=installer_src\wizard_small.bmp
WizardImageStretch=yes
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
russian.WelcomeLabel1=Установка Sora v2.0 — лаунчер для osu!standard (by netleday)
russian.WelcomeLabel2=Мастер установит Sora v2.0 на ваш компьютер. Старые версии будут аккуратно обновлены.

[Tasks]
Name: "desktopicon"; Description: "Создать ярлык на рабочем столе"; GroupDescription: "Дополнительно:"

[Files]
Source: "src-tauri\target\release\sora.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "src-tauri\target\release\sora-realm.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Запустить Sora после установки"; Flags: nowait postinstall skipifsilent
