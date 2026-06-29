const axios = require("axios");

module.exports = {
    async run(vars, numero) {

        try {

            const response = await axios.get(
                "https://salud1.dyndns.org/api/ciudadanopuco/",
                {
                    params: {
                        dni: vars.dni,
                        sexo: vars.sexo,
                        api_key: "b4d9fb57-5033-4fdd-b717-68705df38d35"
                    }
                }
            );
            persona =  response.data.ciudadano

            if (persona.fechaNacimiento) {
                const d = new Date(persona.fechaNacimiento);
            
                persona.fechaNacimiento =
                    String(d.getUTCDate()).padStart(2, "0") + "/" +
                    String(d.getUTCMonth() + 1).padStart(2, "0") + "/" +
                    d.getUTCFullYear();
            }

            return {
                next: "ok",
                vars: {
                    persona: persona
                }
            };

        } catch (e) {

            if (e.response?.status === 404) {
                return {
                    next: "not_found"
                };
            }

            console.error("[consultarPadron]", e);

            return {
                next: "error"
            };
        }
    }
};