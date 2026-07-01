const axios = require("axios");
const FormData = require("form-data");


module.exports = {
    async run(vars, numero) {

        try {

            const response = await axios.get(
                "http://192.168.64.40:5014/digitalizacion/",
                {   
                    proxy: false,
                    params: {
                        documento: vars.dni,
                        sexo: vars.sexo,
                        api_key: "cpjPsswCpdJHAKbvKKJU3Uus9zQmzZB6hLxCejJ0W3GMKSIjF9ulwhC1jwZfKU4m"
                    }
                }
            );
            const persona = response.data.sisa_data.ciudadano;

            if (persona.fechaNacimiento) {
                const d = new Date(persona.fechaNacimiento);
            
                persona.fechaNacimiento =
                    String(d.getUTCDate()).padStart(2, "0") + "/" +
                    String(d.getUTCMonth() + 1).padStart(2, "0") + "/" +
                    d.getUTCFullYear();
            }

            if (response.data.banderas.bandera_hc === "error"){
                console.log("HC ERROR")
                
                try {
                    mensaje = `Existe un error con la historia clínica de la siguiente persona:
                                dni: ${vars.dni}
                                nombre: ${persona.nombre}
                                apellido: ${persona.apellido}`
                   
                    const form = new FormData();

                    form.append("from_email", "ssp_dirinformatica@rosario.gov.ar");
                    form.append("subject", "Error en Historia Clinica");
                    form.append("body", mensaje);
                    form.append("to_emails", "efeuli0@rosario.gov.ar");
                    
                    const mailresponse = await axios.post(
                        "http://192.168.64.40:5002/send-email/",
                        form,
                        {
                            headers: form.getHeaders(),
                            proxy: false
                        }
                    );
                    console.log(mailresponse)
                } catch (e) {
                    console.error(e);

                    console.log("response:", e.response);
                    console.log("status:", e.response?.status);
                    console.log("data:", e.response?.data);
                }
            } 
            results_query = response.data.results_query1[0]
            return {
                next: "ok",
                vars: {
                    persona: persona,
                    results_query
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