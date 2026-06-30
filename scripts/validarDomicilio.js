const axios = require("axios");

module.exports = {
    async run(vars) {
        try {
            const domicilio = encodeURIComponent(vars.domicilio);
            const response = await axios.get(
                `https://ws.rosario.gob.ar/ubicaciones/public/geojson/ubicaciones/all/all/${domicilio}`,
                {
                    timeout: 10000,
                    proxy: false
                }
            );

            let result = response.data.features || [];
            // Solo conservar domicilios válidos
            result = result.filter(feature =>
                feature.geometry &&
                feature.geometry.type === "Point" &&
                feature.properties &&
                feature.properties.nombreCalle
            );
            if (result.length === 0) {
                return {
                        next: "not_found",
                        vars: {}
                    };
            }

            if (result.length === 1) {
                vars.domicilio_validado = result[0];

                const p = result[0].properties;
                vars.domicilio_texto =
                    `${p.nombreCalle} ${p.altura || ""}${p.descripcion ? " - " + p.descripcion : ""}`.trim();

                return {
                        next: "ok",
                        vars
                };
            }

            vars.domicilios = result;

            vars.opciones_domicilio = result
                .map((f, i) => {
                    const p = f.properties;
                    return `${i + 1} - ${p.nombreCalle} ${p.altura || ""}${p.descripcion ? " - " + p.descripcion : ""}`.trim();
                })
                .join("\n");
            
            console.log("OPCIONEs", vars.opciones_domicilio)

            return {
                next: "multiple",
                vars
            };

        } catch (err) {
            if (err.response?.status === 404) {
                return "not_found";
            }

            console.error("Error consultando API GEO1:", err.message);
            return "error";
        }
    }
};