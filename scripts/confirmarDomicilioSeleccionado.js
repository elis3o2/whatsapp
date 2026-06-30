module.exports = {
    async run(vars) {
        const opcion = parseInt(vars.opcion_domicilio, 10);

        if (
            isNaN(opcion) ||
            !Array.isArray(vars.domicilios) ||
            opcion < 1 ||
            opcion > vars.domicilios.length
        ) {
            return {
                next: "error",
                vars
            };
        }

        const domicilio = vars.domicilios[opcion - 1];

        vars.domicilio_validado = domicilio;

        const p = domicilio.properties;

        vars.domicilio_texto =
            `${p.nombreCalle} ${p.altura || ""}${p.descripcion ? " - " + p.descripcion : ""}`.trim();

        return {
            next: "ok",
            vars
        };
    }
};