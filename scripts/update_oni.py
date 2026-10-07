"""Fetch NOAA CPC's Oceanic Nino Index and save it as oni.json for the website (run by GitHub Actions)."""
import json, urllib.request
SEASONS = ["DJF", "JFM", "FMA", "MAM", "AMJ", "MJJ", "JJA", "JAS", "ASO", "SON", "OND", "NDJ"]
txt = urllib.request.urlopen("https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt", timeout=60).read().decode()
rows = []
for line in txt.splitlines():
    p = line.split()
    if len(p) == 4 and p[0] in SEASONS:
        rows.append({"year": int(p[1]), "month": SEASONS.index(p[0]) + 1, "oni": float(p[3])})
assert len(rows) > 500, "unexpected ONI format"
json.dump(rows, open("oni.json", "w"), separators=(",", ":"))
print(f"saved {len(rows)} months, latest {rows[-1]}")
