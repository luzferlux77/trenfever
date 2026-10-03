# TrenFever — actualizaciones

Visor de la red ferroviaria española (Renfe Cercanías/Rodalies, Media y Larga Distancia, AVE, Ouigo, Iryo, FGC)
con trenes en tiempo real.

Este repositorio publica las actualizaciones de la app:

- **`manifest.json`**: lo consulta la app al abrirse para saber si hay datos o una versión nueva.
- **Releases**: paquetes con horarios, líneas y trazados actualizados (la app los descarga sola) y, cuando hay
  cambios en Android, el APK nuevo (`TrenFever-x.y.apk`), que se instala encima del anterior.

Datos: horarios GTFS de Renfe, Ouigo y FGC; vías y andenes © OpenStreetMap (ODbL). Visor no oficial.

## Cómo se actualiza

- **Cada noche** (GitHub Actions, `.github/workflows/actualizar.yml`): descarga los GTFS oficiales, regenera la red y
  los horarios con `tools/build-rail.mjs` y, si algo ha cambiado, publica un paquete nuevo y actualiza `manifest.json`.
  Las vías y andenes (`sources/osm`) y el horario estimado de Iryo se actualizan desde el PC de desarrollo.
- **Cambios de la app**: se publican desde el PC con `tools/publica-actualizacion.mjs` (y el APK cuando hay cambios de Android).
- Para forzar una actualización: pestaña **Actions → Actualizar horarios de TrenFever → Run workflow**.
