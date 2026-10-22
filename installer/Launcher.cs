using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

public static class Launcher {
  public static string Quote(string s) {
    StringBuilder b=new StringBuilder("\"");int slash=0;
    foreach(char c in s){if(c=='\\'){slash++;continue;}if(c=='"'){b.Append('\\',slash*2+1);b.Append(c);}else{b.Append('\\',slash);b.Append(c);}slash=0;}
    b.Append('\\',slash*2);return b.Append('"').ToString();
  }
  public static int Main(string[] args) {
    try {
      string root=Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,".."));
      string version=File.ReadAllText(Path.Combine(root,"current.txt")).Trim();
      if(!Regex.IsMatch(version,@"^\d+\.\d+\.\d+-[a-f0-9]{12}$"))throw new Exception("Invalid installed version. Run the Tern installer to repair it.");
      string dir=Path.Combine(root,"versions",version);
      StringBuilder command=new StringBuilder(Quote(Path.Combine(dir,"cli","tern.mjs")));
      foreach(string arg in args)command.Append(" ").Append(Quote(arg));
      ProcessStartInfo start=new ProcessStartInfo(Path.Combine(dir,"node.exe"),command.ToString());start.UseShellExecute=false;
      using(Process child=Process.Start(start)){child.WaitForExit();return child.ExitCode;}
    }catch(Exception error){Console.Error.WriteLine("Tern: "+error.Message);return 1;}
  }
}
