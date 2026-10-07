# SkyCast AI

An AI weather outlook for any city, up to a year ahead. Ask things like "when is it gonna snow in Denver" or "when is it gonna get colder in Chicago".

Everything runs in the browser: each visit pulls fresh data from Open-Meteo (ECMWF ERA5 history, NOAA GFS / ECMWF / DWD ICON forecasts), trains gradient boosted trees for the city, backtests itself against 30 year normals, and corrects itself from its own track record. A weekly GitHub Action refreshes NOAA's El Niño index (`oni.json`).

Live site: https://maxxx129.github.io/skycast/
