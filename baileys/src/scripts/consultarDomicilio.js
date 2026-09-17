const { getDatosDomicilioSet } = require("../db");
module.exports = {
    async run(vars) {
        const persona = vars.persona;

        if (!persona) {
            return {
                next: "error"
            };
        }

        const datos = getDatosDomicilioSet.get(persona.id);

        let domicilioTexto = "Domicilio: No registrado";

        if (datos) {
            if (datos.domicilio_id) {
                domicilioTexto = `Domicilio: ${datos.domicilio_nombre}` 
            } else if (datos.interseccion_id) {
                domicilioTexto = `Intersección: ${datos.interseccion_nombre}`;
            } else if (datos.domicilio_nr_id) {
                domicilioTexto = `Domicilio informado: ${datos.domicilio_no_registrado}`;
            }
        }

        return {
            next: "ok",
            vars: {
                persona,
                domicilio: datos,
                domicilio_texto: domicilioTexto
            }
        };
    }
};