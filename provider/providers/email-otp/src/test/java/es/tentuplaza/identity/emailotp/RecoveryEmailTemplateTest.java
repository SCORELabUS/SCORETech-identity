package es.tentuplaza.identity.emailotp;

import static org.junit.jupiter.api.Assertions.*;
import freemarker.template.Configuration;
import freemarker.template.TemplateMethodModelEx;
import java.io.StringWriter;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.Test;

class RecoveryEmailTemplateTest {
  @Test void rendersBothRecoveryNotificationsWithTheSharedEmailLayout() throws Exception {
    var config = new Configuration(Configuration.VERSION_2_3_32);
    config.setOutputFormat(freemarker.core.HTMLOutputFormat.INSTANCE);
    config.setDirectoryForTemplateLoading(Path.of("../../themes/score/email/html").toFile());
    var template = config.getTemplate("recovery-notification.ftl");
    TemplateMethodModelEx messages = arguments -> arguments.getFirst().toString().equals("emailFooter")
        ? "You can ignore this email." : "SCORE";
    for (var phase : new String[] {"issued", "completed"}) {
      var output = new StringWriter();
      template.process(Map.of("phase", phase, "realmName", "SCORE", "msg", messages), output);
      var html = output.toString();
      assertTrue(html.contains("<!doctype html>"));
      assertTrue(html.contains("<html lang=\"en\">"));
      assertTrue(html.contains("SCORETech Identity"));
      assertTrue(html.contains("contact SCORETech Identity support immediately"));
      assertTrue(html.contains("SCORETech Identity security notification"));
      assertFalse(html.contains("You can ignore this email."));
      assertTrue(html.contains(phase.equals("issued")
          ? "The link expires in ten minutes." : "Previous sessions have been ended."));
    }
  }
}
