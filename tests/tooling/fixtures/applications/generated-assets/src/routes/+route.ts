import { route } from "hesperia/routing";

export default route({
  render: {
    clientRender: "required",
    ssr: "forbidden",
    stream: "forbidden",
    ssg: "forbidden",
    hydration: "forbidden",
  },
});
