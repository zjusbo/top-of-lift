# Top of Lift (v1)

Paragliding thermal forecast in the style of XC Skies: estimated **top of usable lift** and wind,
from NOAA HRRR / NAM / GFS data via the free [Open-Meteo](https://open-meteo.com/) API.
Static web page, no build step and no backend.

Live site: <https://zjusbo.github.io/top-of-lift/> (GitHub Pages, deployed from `main`).

## Run

ES modules need a web server (opening `index.html` as a file won't work):

```bash
python3 -m http.server 8765 --directory ~/Desktop/top-of-lift
```

Then open <http://127.0.0.1:8765>.

## Views

- **Point forecast**: hourly time-height chart for one site and day. Across the top: **sky** (sunny, partly
  or mostly cloudy, overcast, fog, drizzle, rain, snow, thunder) with cloud cover %, or chance of
  precipitation % in blue on wet hours, and **temperature** (°F or °C). Sites are **Ed Levin** (693 m launch)
  and **Mission Peak** (585 m launch), or any lat/lon. The chart shows the top-of-lift line (labelled),
  boundary-layer top (dashed, labelled "BL top"), net-climb shading and wind arrows at each model level.
  **Cloud icons** mark cloud base: solid where cumulus can form, faded where thermals stay below it, and
  pinned to the top (▲) when it is above the chart. Below the chart: the **wind at launch altitude**,
  colored by launch suitability, and a **gust** row (the model's surface gusts, the only gusts it
  provides). Hover a column for the numbers.
  Above the chart: the model run the data came from and when the next run is due, plus sunrise/sunset
  (also drawn on the chart). A **red line** marks the floor of the lowest Class B/C/D airspace over the site.
  For Ed Levin and Mission Peak that's the SFO Class B at 6,000 ft. The model run, model point, ground
  elevation, k and sink rate are listed under "Forecast details" at the bottom.
- **Map**: grid colored by top of lift (MSL, 1,000 ft bands) with 10 m wind arrows and speeds,
  plus a time slider, day chips and play button. Launch sites show a paraglider icon; click it to open
  that site's point forecast. Click a cell for its values or a point forecast there.
  "Load this view" fetches a new grid for the current map area.

## How TOL is calculated (`js/physics.js`)

1. **BL depth zᵢ** = the forecast model's boundary-layer height.
2. **w\*** = (g/T · H/(ρ·cₚ) · zᵢ)^⅓, where H = surface sensible heat flux.
3. **Updraft profile** w(z) = k · w\* · (z/zᵢ)^⅓ · (1 − 1.1 z/zᵢ) (Lenschow; Allen 2006, NASA, Eq. 11),
   with **k = 1.6**, so the updraft peaks at about 0.73 · w\*.
4. **TOL** = ground + highest z where w(z) ≥ **1.3 m/s** glider sink.
5. **Launch wind** = model wind interpolated to launch altitude between pressure levels. NAM has no
   levels, so it uses the 80 m wind.

These values are fixed in `THERMAL` in `js/app.js` and aren't in the UI. `physics.js` still supports
the parcel method (`ziMethod: 'parcel'`) for calibration experiments.

## Data and limits (`js/data.js`)

| Model | Open-Meteo id | Range | Upper air |
|---|---|---|---|
| HRRR 3 km | `ncep_hrrr_conus` | ~2 days | yes |
| NAM 3 km | `ncep_nam_conus` | ~3 days | **no**, so no wind arrows aloft and launch wind from 80 m |
| GFS 13 km | `gfs_global` | 7 days | yes |

- Free tier: **non-commercial**, 600 calls/min, 10,000/day. A location costs
  max(1, variables/10) calls.
  - A 15×15 map grid is about 225 calls.
  - A point forecast is about 7 calls.
  - Requests are paced automatically. Commercial use needs a paid Open-Meteo plan, or raw NOAA
    GRIB from AWS.
- The thermal calculation drops pressure levels below the point's ground. Launch wind still
  interpolates across them, since they are usually above the model's smoothed 3 km terrain.
- Ground elevation is Open-Meteo's 90 m DEM at the point, which also downscales the 2 m temperature.

## Known limitations

- **Uncalibrated.** k = 1.6 and sink = 1.3 m/s are a choice, not a fit. The next step is checking them
  against real flights (IGC max altitudes vs. archived forecasts).
- 3 km models smooth ridges, so slope heating and sea-breeze timing are only partly captured.
- Cumulus base is a simple spread × 125 m estimate, and TOL is not capped at cloud base.
- The map arrows show 10 m wind. Launch-altitude wind and wind aloft are in the point view.

## Airspace (`fetchAirspace` in `js/data.js`)

The app queries the FAA AIS open-data `Class_Airspace` layer (ArcGIS, CORS-enabled) at the site
point and keeps classes B, C and D. The red line is the lowest floor
overhead whose ceiling is above the launch. US only; this is no substitute for the current sectional
chart or NOTAMs/TFRs.

## Email alerts

The sidebar's "Email alerts" form signs people up for flyable-day emails. A site counts as flyable
when an HRRR hour in daylight has top of lift at least 500 ft above launch and launch wind from S,
SW or W under 10 mph. If a later forecast drops every flyable hour before the window ends, the
people alerted get a "Cancelled" email, and one "Back on" email if it recovers. The backend is a
Google Apps Script in [`alerts/`](alerts/README.md), which has setup steps.
Until `ALERTS_ENDPOINT` in `js/config.js` is set, the form says alerts aren't switched on yet.

## Feedback address

The footer's feedback email is not stored as plain text in the HTML or the repo. `js/feedback.js` keeps
it reversed and base64-encoded, and shows it only after a visitor answers a small sum. Answers given
in under a second, or with the hidden honeypot field filled, are rejected. This blocks address
harvesters, but it is not a full CAPTCHA.

## Tests

```bash
node test/physics.test.mjs
node test/alerts.test.mjs
node test/weather.test.mjs
```
