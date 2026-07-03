const {
  insertInterseccion,
  insertDomicilio,
  insertDomicilioNoRegistrado,
  unsetDomiciliosPersona
} = require("../db");

module.exports = {
  async run(vars, numero) {
    try {
      const persona = vars.id_persona;
      const domicilio_val = vars.domicilio_validado;

      // Desactiva domicilio / interseccion / no-registrado anteriores de esta persona
      unsetDomiciliosPersona(persona);

      if (domicilio_val) {
        if (domicilio_val.codigoInterseccion) {
          insertInterseccion.run({
            id_persona: persona,
            name: domicilio_val.properties.name,
            codigo_interseccion: domicilio_val.properties.codigoInterseccion,
            latitud: domicilio_val.geometry.coordinates[1],   // lat = index 1 en GeoJSON
            longitud: domicilio_val.geometry.coordinates[0],  // lng = index 0 en GeoJSON
            datetime: Date.now()
          });
        } else {
          insertDomicilio.run({
            id_persona: persona,
            name: domicilio_val.properties.name,
            id_calle: domicilio_val.properties.codigoCalle,
            altura: domicilio_val.properties.altura,
            bis: domicilio_val.properties.bis ? 1 : 0,
            latitud: domicilio_val.geometry.coordinates[1],   // lat = index 1 en GeoJSON
            longitud: domicilio_val.geometry.coordinates[0],  // lng = index 0 en GeoJSON
            datetime: Date.now()
          });
        }
      } else {
        insertDomicilioNoRegistrado.run({
          id_persona: persona,
          domicilio: vars.domicilio,
          datetime: Date.now()
        });
      }

      return { next: "ok" };
    } catch (err) {
      console.error("Error guardando asociación:", err);
      return { next: "error" };
    }
  }
};