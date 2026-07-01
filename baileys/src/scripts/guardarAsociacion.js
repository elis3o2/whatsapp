const { stmtUpsertContacto } = require("../db");

module.exports = {
    async run(vars, numero) {

        try {

            stmtUpsertContacto.run({
                numero,
                documento: vars.dni,
                sexo: vars.sexo,
                actualizado: Date.now()
            });
            console.log("NUMERO", numero)
            return {
                next: "ok"
            };

        } catch (err) {

            console.error("Error guardando asociación:", err);

            return {
                next: "error"
            };
        }
    }
};