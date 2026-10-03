# TrenFever — actualizaciones

Visor de la red ferroviaria española (Renfe Cercanías/Rodalies, Media y Larga Distancia, AVE, Ouigo, Iryo, FGC)
con trenes en tiempo real.

Este repositorio publica las actualizaciones de la app:

- **`manifest.json`**: lo consulta la app al abrirse para saber si hay datos o una versión nueva.
- **Releases**: paquetes con horarios, líneas y trazados actualizados (la app los descarga sola) y, cuando hay
  cambios en Android, el APK nuevo (`TrenFever-x.y.apk`), que se instala encima del anterior.

Datos: horarios GTFS de Renfe, Ouigo y FGC; vías y andenes © OpenStreetMap (ODbL). Visor no oficial.
