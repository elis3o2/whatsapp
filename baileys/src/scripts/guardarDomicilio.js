const {
  insertInterseccion,
  insertInterseccionPersona,
  findInterseccion,
  insertDomicilio,
  insertDomicilioPersona,
  findDomicilio,
  insertDomicilioNoRegistrado,
  unsetDomiciliosPersona
} = require("../db");

module.exports = {
  async run(vars) {
    try {

      const id_persona = vars.id_persona;
      const domicilio_val = vars.domicilio_validado;
      const now = Date.now();

      unsetDomiciliosPersona(id_persona, now);

      if (!domicilio_val) {

        insertDomicilioNoRegistrado.run({
          id_persona,
          domicilio: vars.domicilio,
          datetime: now
        });

        return { next: "ok" };
      }

      if (domicilio_val.properties.codigoInterseccion) {

        let inter = findInterseccion.get(
            domicilio_val.properties.codigoInterseccion
        );

        if (!inter) {

          const info = {
            name: domicilio_val.properties.name,
            codigo_interseccion: domicilio_val.properties.codigoInterseccion,
            latitud: domicilio_val.geometry.coordinates[1],
            longitud: domicilio_val.geometry.coordinates[0],
            datetime: now
          };

          const result = insertInterseccion.run(info);
          inter = { id: result.lastInsertRowid };
        }

        insertInterseccionPersona.run({
          id_interseccion: inter.id,
          id_persona,
          estado: 1,
          datetime: now
        });

      } else {

        const bis = domicilio_val.properties.bis ? 1 : 0;

        let dom = findDomicilio.get(
            domicilio_val.properties.codigoCalle,
            domicilio_val.properties.altura,
            bis
        );

        if (!dom) {

          const info = {
            name: domicilio_val.properties.name,
            id_calle: domicilio_val.properties.codigoCalle,
            altura: domicilio_val.properties.altura,
            bis,
            latitud: domicilio_val.geometry.coordinates[1],
            longitud: domicilio_val.geometry.coordinates[0],
            datetime: now
          };

          const result = insertDomicilio.run(info);
          dom = { id: result.lastInsertRowid };
        }

        insertDomicilioPersona.run({
          id_domicilio: dom.id,
          id_persona,
          estado: 1,
          datetime: now
        });
      }

      return { next: "ok" };

    } catch (err) {
      console.error("Error guardando asociación:", err);
      return { next: "error" };
    }
  }
};