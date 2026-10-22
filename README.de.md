# OSA Control

[English](README.md)

Lokales Dashboard für Claude-Code- und Codex-Sitzungen: Aufgaben, Ergebnisse,
Tokenverbrauch, geschätzte Aktivität und nächste Schritte für offene Arbeit.
Die App-Oberfläche ist Englisch.

## Sichere Demo

Voraussetzung: Node.js ab 22.6 mit TypeScript-Stripping und npm. Geprüft: Node.js 24.15.0.

```sh
npm ci
npm run demo
```

http://127.0.0.1:3000 öffnen. Die künstlichen Sitzungen stammen vom 19.08.2026.
API-Schlüssel und Modelldienste sind nicht nötig. Persönliche Quellpfade und
Parser-Overrides werden ignoriert. Fehlende Beispiele lösen keinen Rückfall auf
persönliche Sitzungen aus.

Produktionsvorschau (POSIX-Shell):

```sh
npm run build
DASHBOARD_DEMO=1 npm start
```

Die Node.js-App kann nicht als statische GitHub-Pages-Seite laufen. Eine separate
Portfolioseite kann sie vorstellen. Fortsetzungsbefehle der Demo verwenden erfundene
Pfade und IDs und können keine echten Sitzungen fortsetzen.

## Funktionen und Architektur

- Claude-/Codex-JSONL auswerten, Tagesrückblick und Aufgabenübersicht über sieben Tage.
- Nach Datum, Agent, Subagenten, Umfang und Text filtern.
- Offen, blockiert oder erledigt markieren, nächste Schritte notieren und Befehle kopieren.

```text
JSONL-Quellen -> Sitzungsparser -> Tagesaggregation -> Server-Oberfläche
                                                     |
                                  lokale Aktion -> Status-JSON
```

`app/page.tsx` rendert das Dashboard. `lib/sessions.ts` vereinheitlicht Ereignisse und
puffert Auswertungen anhand von Dateigröße und Änderungszeit. `lib/work-state.ts`
validiert Status und Notizen und speichert sie durch atomaren Dateiaustausch.
`app/actions.ts` verarbeitet lokale Änderungen. Formulare übernehmen den neu
gespeicherten Zustand nach einer Änderung.

Demo-Quellen: `demo/claude`, `demo/codex`; Demo-Status: `.data/demo-work-state.json`.
Der Normalmodus verwendet separate Quellen und standardmäßig `.data/work-state.json`.
Laufzeitdaten, Abhängigkeiten und Build-Dateien werden nicht versioniert.

## Persönlicher lokaler Einsatz

`npm run dev` liest standardmäßig `~/.claude/projects` und `~/.codex/sessions`.
Darin können private und berufliche Gespräche stehen. Nur erlaubte Quellen verwenden;
für Screenshots, Bildschirmfreigabe und öffentliche Vorführungen die Demo nutzen.

| Variable | Bedeutung |
|---|---|
| `CLAUDE_PROJECTS_DIR` | Claude-Code-Sitzungsordner |
| `CODEX_SESSIONS_DIR` | Codex-Sitzungsordner |
| `DASHBOARD_STATE_FILE` | Statusdatei |
| `DASHBOARD_TIME_ZONE` | Zeitzone; Standard `Europe/Berlin` |
| `DASHBOARD_DEMO` | `1` aktiviert künstliche Quellen und getrennten Demo-Status |

Die Demo ignoriert die ersten drei Variablen. Die App bindet an localhost und liest
Quellen serverseitig, ohne sie zu verändern. Im Normalmodus wird Sitzungstext nicht
automatisch geschwärzt. Diesen Modus nicht öffentlich oder per Tunnel zugänglich
machen: Eine Mehrbenutzer-Anmeldung ist nicht vorhanden.

## Prüfung und Grenzen

`npm run check` prüft TypeScript, Parser-/Status-/Demo-Tests und den Produktions-Build.
Tests nutzen künstliche Eingaben und temporäre Statusdateien statt persönlicher Quellen.

Aktivität ist eine Schätzung aus Ereignisabständen mit maximal zehn Minuten je
Abstand, kein Arbeitszeitnachweis. Der Live-Status basiert auf Dateiänderungszeiten;
kopierte Beispiele können aktiv erscheinen. Tokenzahlen sind keine Rechnung.
Quellformate können sich ändern; fehlerhafte oder unlesbare Sitzungen können
übersprungen werden. Atomare Statusdateien koordinieren keine gleichzeitigen Änderungen.
Das Dashboard implementiert weder RAG noch Modellinferenz.

Vor Weitergabe müssen Veröffentlichungsrechte und Lizenz geklärt sein.
