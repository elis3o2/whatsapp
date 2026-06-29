const axios = require("axios");

module.exports = {

    validarDni(ctx){

        const dni = ctx.vars.dni;

        if(!dni)
            return "error";

        if(!/^\d{7,8}$/.test(dni))
            return "error";

        return "ok";
    },

    async consultarPadron(ctx){

        try{

            const response = await axios.get(
                "https://salud1.dyndns.org/api/ciudadanopuco/",
                {
                    params:{
                        dni:ctx.vars.dni,
                        sexo:ctx.vars.sexo,
                        api_key:"b4d9fb57-5033-4fdd-b717-68705df38d35"
                    }
                }
            );

            if(response.status == 404)
                return "not_found";

            ctx.vars.persona = response.data;

            return "ok";

        }catch(e){

            if(e.response?.status == 404)
                return "not_found";

            console.error(e);

            return "error";

        }

    }

}